require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");

const fs = require("fs");
const https = require("https");

// ─── Config ────────────────────────────────────────────────────────────────
const CONFIG = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  supportCategoryId: process.env.SUPPORT_CATEGORY_ID,
  logChannelId: process.env.LOG_CHANNEL_ID,
  adminRoleId: process.env.ADMIN_ROLE_ID,
  ticketPanelChannelId: process.env.PANEL_CHANNEL_ID,
  geminiKey: process.env.GEMINI_API_KEY || null,
};

// ─── Storage ───────────────────────────────────────────────────────────────
const DB_PATH = "./tickets.json";
function loadDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(DB_PATH));
}
function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── Client ────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ─── Helpers ───────────────────────────────────────────────────────────────
function generateTicketId() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}
function statusEmoji(s) {
  return { open: "🟢", pending: "🟡", closed: "🔴" }[s] ?? "⚪";
}
function isAdmin(member, guild) {
  return member?.roles.cache.has(CONFIG.adminRoleId) || guild.ownerId === member?.id;
}

// ─── Issue classifier ──────────────────────────────────────────────────────
function classifyIssue(text) {
  const t = text.toLowerCase();
  if (/login|log in|sign in|password|2fa|two factor|locked out|cant access|cannot access|account access/.test(t)) return "login";
  if (/seed phrase|recovery phrase|private key|mnemonic|backup phrase/.test(t)) return "seed";
  if (/swap|exchange|trade|dex|uniswap|pancake|1inch/.test(t)) return "swap";
  if (/stuck|pending|failed transaction|tx failed|transaction not/.test(t)) return "tx";
  if (/hack|scam|stolen|unauthorized|phishing|drained/.test(t)) return "hack";
  if (/migrat|bridge|cross.chain/.test(t)) return "swap";
  if (/lost|missing|disappear|gone|cant find|cannot find|no access/.test(t)) return "lost";
  if (/withdraw|deposit|transfer|send|receive/.test(t)) return "transfer";
  return "general";
}

// ─── Required fields per issue type ───────────────────────────────────────
function getRequiredFields(issueType) {
  switch (issueType) {
    case "login":   return ["issue", "walletType", "duration"];
    case "seed":    return ["issue", "walletType", "duration"];
    case "swap":    return ["issue", "walletType", "walletAddress", "amount"];
    case "tx":      return ["issue", "walletType", "walletAddress", "transactionId", "amount"];
    case "hack":    return ["issue", "walletType", "walletAddress", "amount", "duration"];
    case "lost":    return ["issue", "walletType", "walletAddress", "duration"];
    case "transfer":return ["issue", "walletType", "walletAddress", "amount"];
    default:        return ["issue", "walletType", "walletAddress", "duration"];
  }
}

// ─── Next question based on what is missing ───────────────────────────────
function getNextQuestion(collected, issueType, username) {
  const required = getRequiredFields(issueType);
  const c = collected || {};

  for (const field of required) {
    if (!c[field]) {
      switch (field) {
        case "walletType":
          return `What type of wallet are you using? (e.g. **MetaMask**, **Trust Wallet**, **OKX**, **Coinbase**, **Phantom**, **Ledger**) 💼`;
        case "walletAddress":
          return `Please provide your **wallet address** so I can investigate on the blockchain. 🔗`;
        case "duration":
          return `How long have you been experiencing this issue? (e.g. just today, a few hours, since yesterday, over a week) 🕐`;
        case "transactionId":
          return `Do you have a **transaction ID / hash** for this issue? If yes paste it below, if not type **No**. 🔎`;
        case "amount":
          return `What **amount** is involved? Please include the coin/token name (e.g. **0.5 ETH**, **200 USDT**, **0.002 BTC**). 💰`;
      }
    }
  }
  return null; // all fields collected
}

// ─── Extract info from user message ───────────────────────────────────────
function extractInfo(text, collected) {
  const t = text.trim().toLowerCase();
  const c = { ...collected };

  // Wallet type
  const wallets = ["metamask","trust wallet","trustwallet","coinbase","phantom","ledger","trezor","okx","bybit","binance","kraken","exodus","rainbow","argent","safe","imtoken","tokenpocket","bitkeep","safepal","mathwallet","coin98","near","petra","solflare","backpack"];
  if (!c.walletType) {
    const found = wallets.find(w => t.includes(w));
    if (found) c.walletType = found.charAt(0).toUpperCase() + found.slice(1);
  }

  // Wallet address
  if (!c.walletAddress && /0x[0-9a-fA-F]{10,}/i.test(text.trim())) {
    const match = text.trim().match(/0x[0-9a-fA-F]{40}/i);
    if (match) c.walletAddress = match[0];
  }

  // Transaction hash (long hex string)
  if (!c.transactionId) {
    const txMatch = text.trim().match(/0x[0-9a-fA-F]{60,}/i);
    if (txMatch) c.transactionId = txMatch[0];
    else if (/no transaction|no tx|don.t have|dont have|no hash|n\/a/i.test(t)) c.transactionId = "Not provided";
  }

  // Amount — accept anything that could reasonably be an amount
  if (!c.amount) {
    const tAmt = text.trim().toLowerCase();
    // "no", "none", "n/a" — user has no amount to provide
    if (/^(no|none|n\/a|na|not sure|unknown|nothing|no amount|i don.t know|dont know)$/.test(tAmt)) {
      c.amount = "Not specified";
    }
    // number + coin name (e.g. "200 usdt", "0.5 eth", "1000 memecoin")
    else if (/[\d,.]+\s*[a-zA-Z]+/.test(text) && !/^0x/i.test(text.trim())) {
      const m = text.match(/[\d,.]+\s*[a-zA-Z]+/);
      if (m) c.amount = m[0].trim();
    }
    // dollar sign (e.g. "$200", "$1,500")
    else if (/\$[\d,.]+/.test(text)) {
      const m = text.match(/\$[\d,.]+/);
      if (m) c.amount = m[0].trim();
    }
    // plain number only (e.g. "200", "1000", "0.5")
    else if (/^[\d,.]+$/.test(tAmt)) {
      c.amount = text.trim();
    }
    // coin/token name only with no number (e.g. "memecoin", "shiba inu", "pepe token")
    else if (tAmt.length > 3 && tAmt.length < 40 && /^[a-z][a-z\s]*(coin|token|swap|inu|finance|protocol|dao|cash|usd)?$/i.test(tAmt) && !["metamask","coinbase","phantom","ledger","trezor","binance","exodus","rainbow","trustwallet","trust wallet","okx","bybit","kraken"].includes(tAmt) && !/wallet|address|issue|problem|error|help|support/.test(tAmt)) {
      c.amount = text.trim();
    }
    // number + usd/dollars (e.g. "200 usd", "200 dollars worth")
    else if (/[\d,.]+\s*(usd|dollars?|worth)/i.test(text)) {
      const m = text.match(/[\d,.]+\s*(usd|dollars?|worth)/i);
      if (m) c.amount = m[0].trim();
    }
  }
  // Duration
  if (!c.duration) {
    if (/just now|just started|right now|few minutes|minutes ago/i.test(t)) c.duration = "Just started";
    else if (/today|this morning|this afternoon|this evening|few hours|hours ago/i.test(t)) c.duration = "Today";
    else if (/yesterday/i.test(t)) c.duration = "Since yesterday";
    else if (/\d+\s*days?/i.test(t)) { const m = t.match(/(\d+)\s*days?/i); c.duration = m[1] + " days"; }
    else if (/\d+\s*weeks?/i.test(t)) { const m = t.match(/(\d+)\s*weeks?/i); c.duration = m[1] + " weeks"; }
    else if (/\d+\s*months?/i.test(t)) { const m = t.match(/(\d+)\s*months?/i); c.duration = m[1] + " months"; }
    else if (/week/i.test(t)) c.duration = "Over a week";
    else if (/month/i.test(t)) c.duration = "Over a month";
    else if (/long time|while/i.test(t)) c.duration = "A long time";
  }

  return c;
}

// ─── Is junk ──────────────────────────────────────────────────────────────
function isJunk(text) {
  const t = text.trim().toLowerCase();
  if (t.length <= 1) return true;
  if (/^(.){3,}$/.test(t)) return true;
  if (/^[b-df-hj-np-tv-z]{4,}$/i.test(t)) return true; // no vowels
  const junk = ["ok","okay","k","kk","lol","lmao","haha","idk","um","uh","hmm","test","...","??","fine","good","nice","cool","great","sure","yep","nope","yeah","nah"];
  return junk.includes(t);
}

// ─── Is greeting ──────────────────────────────────────────────────────────
function isGreeting(text) {
  const t = text.trim().toLowerCase();
  const greetings = ["hi","hey","hello","hii","heyyy","good morning","good afternoon","good evening","morning","afternoon","howdy","sup","yo","whats up","what's up"];
  return greetings.some(g => t === g || t === g + "!" || t === g + "?");
}

// ─── Gemini (optional enhancement) ────────────────────────────────────────
async function tryGemini(conversationHistory, geminiKey) {
  if (!geminiKey) return null;
  try {
    const prompt = `You are a crypto support ticket bot. Analyze this conversation and extract any information the user has provided.

Conversation:
${conversationHistory}

Reply ONLY with this JSON, no other text:
{"issue":"summary or null","walletType":"name or null","walletAddress":"address or null","duration":"how long or null","transactionId":"hash or null","amount":"amount or null","issueType":"login|seed|swap|tx|hack|lost|transfer|general"}`;

    const postData = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.1 }
    });

    const result = await new Promise((resolve, reject) => {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" + geminiKey;
      const urlObj = new URL(url);
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) }
      }, (res) => {
        let body = "";
        res.on("data", (c) => body += c);
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.on("error", reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
      req.write(postData);
      req.end();
    });

    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    console.log("Gemini optional enhancement failed:", e.message);
    return null;
  }
}

// ─── Panel ─────────────────────────────────────────────────────────────────
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("Ticket Creation 📨")
    .setDescription("Please click on the button below to create a ticket 👇")
    .setColor(0x2b2d31)
    .setAuthor({ name: "Support Ticket", iconURL: client.user.displayAvatarURL() });
}
function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_ticket").setLabel("Create Ticket").setEmoji("📨").setStyle(ButtonStyle.Secondary)
  );
}
async function sendPanel(channel) {
  await channel.permissionOverwrites.edit(channel.guild.id, { SendMessages: false, ViewChannel: true }).catch(() => {});
  await channel.send({ embeds: [buildPanelEmbed()], components: [buildPanelRow()] });
}

// ─── Ready ─────────────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.get(CONFIG.guildId);
  if (!guild) return console.error("❌ Guild not found.");
  await guild.commands.set([
    { name: "panel", description: "Post the ticket panel (admin only)" },
    { name: "tickets", description: "List all tickets (admin only)" },
    { name: "ticket", description: "Look up a ticket by ID (admin only)", options: [{ name: "id", description: "Ticket ID", type: 3, required: true }] },
    { name: "mystatus", description: "Check your open tickets" },
  ]);
  console.log("✅ Slash commands registered.");
});

// ─── Interactions ──────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  const guild = interaction.guild;

  if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
    if (!isAdmin(interaction.member, guild)) return interaction.reply({ content: "❌ Admins only.", flags: 64 });
    await sendPanel(interaction.channel);
    return interaction.reply({ content: "✅ Panel sent!", flags: 64 });
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "tickets") {
    if (!isAdmin(interaction.member, guild)) return interaction.reply({ content: "❌ Admins only.", flags: 64 });
    const db = loadDB();
    const entries = Object.values(db);
    if (!entries.length) return interaction.reply({ content: "No tickets yet.", flags: 64 });
    const list = entries.slice(-20).map((t) => `${statusEmoji(t.status)} **#${t.id}** *(${t.status})* — <@${t.userId}>`).join("\n");
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle("📋 All Tickets (last 20)").setDescription(list).setColor(0x5865f2)], flags: 64 });
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "ticket") {
    if (!isAdmin(interaction.member, guild)) return interaction.reply({ content: "❌ Admins only.", flags: 64 });
    const id = interaction.options.getString("id");
    const db = loadDB();
    const ticket = db[id];
    if (!ticket) return interaction.reply({ content: `❌ Ticket #${id} not found.`, flags: 64 });
    const c = ticket.collected || {};
    const embed = new EmbedBuilder()
      .setTitle(`🎫 Ticket #${ticket.id}`)
      .setColor(ticket.status === "open" ? 0x57f287 : 0xed4245)
      .addFields(
        { name: "Status", value: `${statusEmoji(ticket.status)} ${ticket.status}`, inline: true },
        { name: "Opened by", value: `<@${ticket.userId}>`, inline: true },
        { name: "Opened at", value: new Date(ticket.openedAt).toUTCString() },
        { name: "Issue", value: c.issue || "Not provided" },
        { name: "Wallet Type", value: c.walletType || "Not provided", inline: true },
        { name: "Wallet Address", value: c.walletAddress || "Not provided", inline: true },
        { name: "Duration", value: c.duration || "Not applicable", inline: true },
        { name: "Transaction ID", value: c.transactionId || "Not applicable", inline: true },
        { name: "Amount", value: c.amount || "Not applicable", inline: true },
      );
    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "mystatus") {
    const db = loadDB();
    const myTickets = Object.values(db).filter((t) => t.userId === interaction.user.id);
    if (!myTickets.length) return interaction.reply({ content: "You have no tickets.", flags: 64 });
    const list = myTickets.map((t) => `${statusEmoji(t.status)} **#${t.id}** *(${t.status})*`).join("\n");
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle("🎫 Your Tickets").setDescription(list).setColor(0x5865f2)], flags: 64 });
  }

  // ── Create Ticket ─────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "open_ticket") {
    await interaction.deferReply({ flags: 64 });
    const ticketId = generateTicketId();
    const username = interaction.user.username;
    const permissionOverwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks] },
    ];
    if (CONFIG.adminRoleId && /^\d+$/.test(CONFIG.adminRoleId)) {
      permissionOverwrites.push({ id: CONFIG.adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    }
    let channel;
    try {
      channel = await guild.channels.create({
        name: `ticket-${username.toLowerCase().replace(/[^a-z0-9]/g, "")}${ticketId}`,
        type: ChannelType.GuildText,
        parent: CONFIG.supportCategoryId ?? null,
        permissionOverwrites,
      });
    } catch (err) {
      return interaction.editReply({ content: "Failed to create ticket. Please contact an admin." });
    }
    const db = loadDB();
    db[ticketId] = {
      id: ticketId,
      userId: interaction.user.id,
      username: interaction.user.username,
      subject: "Support Request",
      description: "No description provided.",
      status: "open",
      channelId: channel.id,
      openedAt: Date.now(),
      replies: [],
      conversationHistory: "",
      collected: {},
      issueType: "general",
      infoComplete: false,
    };
    saveDB(db);
    const ticketEmbed = new EmbedBuilder()
      .setAuthor({ name: "Support Ticket", iconURL: client.user.displayAvatarURL() })
      .setTitle("Ticket Created 📨")
      .setDescription(`Thanks **${username}** for contacting the support team.\nPlease explain your case so we can help you as quickly as possible.`)
      .setColor(0x2b2d31);
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_${ticketId}`).setLabel("Claim").setEmoji("📨").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`close_${ticketId}`).setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Danger)
    );
    const ticketMsg = await channel.send({ embeds: [ticketEmbed], components: [actionRow] });
    await ticketMsg.pin().catch(() => {});
    await ticketMsg.reply(`Hello <@${interaction.user.id}>, how may I assist you today?`);
    return interaction.editReply({ content: `Ticket created! Please check <#${channel.id}>` });
  }

  // ── Claim ─────────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("claim_")) {
    if (!isAdmin(interaction.member, guild)) return interaction.reply({ content: "❌ No permission.", flags: 64 });
    await interaction.deferReply({ flags: 64 });
    const ticketId = interaction.customId.split("_")[1];
    const db = loadDB();
    if (!db[ticketId]) return interaction.editReply({ content: "❌ Ticket not found." });
    if (db[ticketId].claimedBy) return interaction.editReply({ content: `❌ Already claimed by <@${db[ticketId].claimedBy}>.` });
    db[ticketId].claimedBy = interaction.user.id;
    saveDB(db);
    const claimedEmbed = new EmbedBuilder()
      .setAuthor({ name: "Support Ticket", iconURL: client.user.displayAvatarURL() })
      .setTitle("Ticket Claimed ✅")
      .setDescription(`Thanks <@${db[ticketId].userId}> for contacting the support team.\nYour ticket has been assigned to **${interaction.user.username}**.`)
      .setColor(0x5865f2);
    const updatedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_${ticketId}`).setLabel("Claimed").setEmoji("✅").setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId(`close_${ticketId}`).setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Danger)
    );
    await interaction.message.edit({ embeds: [claimedEmbed], components: [updatedRow] });
    await interaction.channel.setName(`claimed-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, "")}`).catch(() => {});
    await interaction.channel.send(`<@${interaction.user.id}> is now handling this ticket`);
    const agentAvatar = interaction.user.displayAvatarURL({ dynamic: true, size: 128 });
    const sessionEmbed = new EmbedBuilder()
      .setTitle("📨 Session Initialized")
      .setDescription(
        `**Agent:** <@${interaction.user.id}>\n` +
        `**Response Time:** less than 1 min\n` +
        `**Status:** 🧍 Human-review\n\n` +
        `🛡️ **Verification Status**\n` +
        "```css\n✅ Verified Support Specialist```"
      )
      .setThumbnail(agentAvatar)
      .setColor(0x2b2d31)
      .setFooter({ text: `📨 • Today at ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` });
    await interaction.channel.send({ embeds: [sessionEmbed] });
    await interaction.channel.send("I understand you need help. Let me connect you with our support team who can assist you better.");
    return interaction.editReply({ content: "✅ You have claimed this ticket." });
  }

  // ── Close ─────────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("close_")) {
    if (!isAdmin(interaction.member, guild)) return interaction.reply({ content: "❌ Admins only.", flags: 64 });
    const ticketId = interaction.customId.split("_")[1];
    const db = loadDB();
    if (!db[ticketId]) return interaction.reply({ content: "❌ Ticket not found.", flags: 64 });
    db[ticketId].status = "closed";
    db[ticketId].closedAt = Date.now();
    saveDB(db);
    await interaction.channel.send(
      `🔒 This ticket has been **closed** by **${interaction.user.username}**.\n\n` +
      `Thank you <@${db[ticketId].userId}> for reaching out! We hope your issue has been resolved 🙏\n\n` +
      `If you need further help, open a **new ticket** anytime in <#${CONFIG.ticketPanelChannelId}>.\n\n` +
      `This channel will be deleted in **10 seconds**.`
    );
    await interaction.reply({ content: "✅ Closing ticket...", flags: 64 });
    setTimeout(async () => { await interaction.channel.delete().catch(() => {}); }, 10000);
  }
});

// ─── New Member Join ───────────────────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  try {
    const owner = await member.guild.fetchOwner();
    await owner.send(`🔔 **${member.user.username}** just joined **${member.guild.name}**.`);
  } catch { console.log("Could not DM owner."); }
});

// ─── Message Handler ───────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const db = loadDB();
  const guild = message.guild;

  // Admin !reply command
  if (message.content.startsWith("!reply ") && isAdmin(message.member, guild)) {
    const ticket = Object.values(db).find((t) => t.channelId === message.channel.id);
    if (!ticket) return;
    const replyText = message.content.slice(7).trim();
    if (!replyText) return;
    await message.delete().catch(() => {});
    const adminEmbed = new EmbedBuilder()
      .setAuthor({ name: `${message.author.username} (Support Agent)`, iconURL: message.author.displayAvatarURL() })
      .setDescription(replyText)
      .setColor(0x5865f2)
      .setTimestamp();
    await message.channel.send({ embeds: [adminEmbed] });
    ticket.replies.push({ author: message.author.tag, message: replyText.slice(0, 300), timestamp: Date.now() });
    saveDB(db);
    return;
  }

  const ticket = Object.values(db).find((t) => t.channelId === message.channel.id);
  if (!ticket || ticket.status === "closed") return;
  if (isAdmin(message.member, guild)) return;

  ticket.replies.push({ author: message.author.tag, message: message.content.slice(0, 500), timestamp: Date.now() });
  if (ticket.claimedBy) { saveDB(db); return; }

  await message.channel.sendTyping();
  await new Promise((r) => setTimeout(r, 1500));

  const text = message.content.trim();
  const tLower = text.toLowerCase();

  // ── Greeting ──────────────────────────────────────────────────────────────
  if (isGreeting(text) && !ticket.collected?.issue) {
    ticket.conversationHistory = (ticket.conversationHistory || "") + `User: ${text}\n`;
    saveDB(db);
    await message.channel.send(`Hello **${message.author.username}**! 👋 How are you?\n\nI\'m here to help with any crypto issues. Could you please describe what\'s going on so I can assist you? 🔍`);
    return;
  }

  // ── Junk ──────────────────────────────────────────────────────────────────
  if (isJunk(text)) {
    saveDB(db);
    if (!ticket.collected?.issue) {
      await message.channel.send(`Please describe your crypto issue, **${message.author.username}**. What exactly is happening? 🔍`);
    } else {
      const nextQ = getNextQuestion(ticket.collected, ticket.issueType, message.author.username);
      await message.channel.send(nextQ || `Could you please elaborate a bit more? 🔍`);
    }
    return;
  }

  // ── Extract info from message ─────────────────────────────────────────────
  ticket.collected = extractInfo(text, ticket.collected || {});
  ticket.conversationHistory = (ticket.conversationHistory || "") + `User: ${text}\n`;

  // ── Classify issue on first meaningful message ────────────────────────────
  if (!ticket.collected.issue) {
    ticket.collected.issue = text.slice(0, 200);
    ticket.issueType = classifyIssue(text);
  }

  // ── Try Gemini to enhance extraction (fire and forget if it fails) ────────
  if (CONFIG.geminiKey) {
    tryGemini(ticket.conversationHistory, CONFIG.geminiKey).then(geminiData => {
      if (geminiData) {
        const db2 = loadDB();
        const t2 = Object.values(db2).find(t => t.channelId === message.channel.id);
        if (t2 && !t2.claimedBy) {
          for (const [key, val] of Object.entries(geminiData)) {
            if (val && val !== "null" && key !== "issueType" && !t2.collected[key]) {
              t2.collected[key] = val;
            }
          }
          if (geminiData.issueType && geminiData.issueType !== "null") {
            t2.issueType = geminiData.issueType;
          }
          saveDB(db2);
        }
      }
    }).catch(() => {});
  }

  // ── Get next question ─────────────────────────────────────────────────────
  const nextQuestion = getNextQuestion(ticket.collected, ticket.issueType, message.author.username);

  if (!nextQuestion) {
    // All info collected
    ticket.infoComplete = true;
    saveDB(db);

    const c = ticket.collected;
    const summaryLines = [
      c.issue     ? `• **Issue:** ${c.issue.slice(0, 100)}` : null,
      c.walletType ? `• **Wallet:** ${c.walletType}` : null,
      c.walletAddress ? `• **Address:** \`${c.walletAddress}\`` : null,
      c.duration  ? `• **Duration:** ${c.duration}` : null,
      c.transactionId && c.transactionId !== "Not provided" ? `• **Transaction ID:** \`${c.transactionId}\`` : null,
      c.amount    ? `• **Amount:** ${c.amount}` : null,
    ].filter(Boolean).join("\n");

    await message.channel.send(
      `✅ **Thank you ${message.author.username}!**\n\nWe have everything we need to assist you.\n\n📋 **Summary:**\n${summaryLines}\n\n⏳ A support agent has been notified and will be with you shortly. Please remain in this ticket. 🙏`
    );
    return;
  }

  saveDB(db);

  // ── Contextual acknowledgement + next question ────────────────────────────
  let ack = "";
  if (!ticket.collected.walletType && tLower.includes("swap")) ack = "I see you\'re having a swap issue. ";
  else if (!ticket.collected.walletType && /lost|missing|gone/i.test(tLower)) ack = "I\'m sorry to hear that. ";
  else if (!ticket.collected.walletType && /hack|scam|stolen/i.test(tLower)) ack = "I understand this is urgent. ";
  else if (!ticket.collected.walletType && /migrat|bridge/i.test(tLower)) ack = "Thanks for letting me know about the migration issue. ";
  else if (ticket.collected.walletType && !ticket.collected.walletAddress) ack = `Thanks for providing your wallet type as **${ticket.collected.walletType}**. `;
  else if (ticket.collected.walletAddress && !ticket.collected.duration) ack = "Got it. ";
  else ack = "Thank you! ";

  await message.channel.send(`${ack}${nextQuestion}`);
});

// ─── Global Error Handler ─────────────────────────────────────────────────
client.on("error", (err) => console.error("⚠️ Client error:", err.message));
process.on("unhandledRejection", (err) => console.error("⚠️ Unhandled rejection:", err?.message ?? err));

// ─── Login ────────────────────────────────────────────────────────────────
client.login(CONFIG.token);
