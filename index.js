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

// ─── Configuration ─────────────────────────────────────────────────────────
const CONFIG = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  supportCategoryId: process.env.SUPPORT_CATEGORY_ID,
  logChannelId: process.env.LOG_CHANNEL_ID,
  adminRoleId: process.env.ADMIN_ROLE_ID,
  ticketPanelChannelId: process.env.PANEL_CHANNEL_ID,
  geminiKey: process.env.GEMINI_API_KEY || null,
};

// ─── Database Helpers ──────────────────────────────────────────────────────
const DB_PATH = "./tickets.json";
function loadDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(DB_PATH));
}
function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── Discord Client ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ─── Utility Functions ─────────────────────────────────────────────────────
function generateTicketId() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}
function statusEmoji(s) {
  return { open: "🟢", pending: "🟡", closed: "🔴" }[s] ?? "⚪";
}
function isAdmin(member, guild) {
  return member?.roles.cache.has(CONFIG.adminRoleId) || guild.ownerId === member?.id;
}

// ─── Issue Classifier ──────────────────────────────────────────────────────
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

// ─── Required Fields per Issue Type ───────────────────────────────────────
function getRequiredFields(issueType) {
  switch (issueType) {
    case "login":    return ["issue", "walletType", "duration"];
    case "seed":     return ["issue", "walletType", "duration"];
    case "swap":     return ["issue", "walletType", "walletAddress", "amount"];
    case "tx":       return ["issue", "walletType", "walletAddress", "transactionId", "amount"];
    case "hack":     return ["issue", "walletType", "walletAddress", "amount", "duration"];
    case "lost":     return ["issue", "walletType", "walletAddress", "duration"];
    case "transfer": return ["issue", "walletType", "walletAddress", "amount"];
    default:         return ["issue", "walletType", "walletAddress", "duration"];
  }
}

// ─── Next Question Logic ───────────────────────────────────────────────────
function getNextQuestion(collected, issueType, username) {
  const required = getRequiredFields(issueType);
  const c = collected || {};

  for (const field of required) {
    if (!c[field]) {
      switch (field) {
        case "walletType":
          return `Which wallet are you using? (e.g. **MetaMask**, **Trust Wallet**, **OKX**, **Coinbase**, **Phantom**, **Ledger**) 💼`;
        case "walletAddress":
          return `Please share your **wallet address** so our team can investigate on-chain. 🔗`;
        case "duration":
          return `How long has this been happening? (e.g. just started, a few hours, since yesterday, over a week) 🕐`;
        case "transactionId":
          return `Do you have the **transaction hash / ID** linked to this issue? Paste it below — or type **No** if you don't. 🔎`;
        case "amount":
          return `What **amount** is involved? Include the token name (e.g. **0.5 ETH**, **150 USDT**, **0.01 BTC**). 💰`;
      }
    }
  }
  return null;
}

// ─── Info Extractor ────────────────────────────────────────────────────────
function extractInfo(text, collected) {
  const t = text.trim().toLowerCase();
  const c = { ...collected };

  // Wallet type detection
  const wallets = ["metamask","trust wallet","trustwallet","coinbase","phantom","ledger","trezor","okx","bybit","binance","kraken","exodus","rainbow","argent","safe","imtoken","tokenpocket","bitkeep","safepal","mathwallet","coin98","near","petra","solflare","backpack"];
  if (!c.walletType) {
    const found = wallets.find(w => t.includes(w));
    if (found) c.walletType = found.charAt(0).toUpperCase() + found.slice(1);
  }

  // Wallet address detection
  if (!c.walletAddress && /0x[0-9a-fA-F]{10,}/i.test(text.trim())) {
    const match = text.trim().match(/0x[0-9a-fA-F]{40}/i);
    if (match) c.walletAddress = match[0];
  }

  // Transaction hash detection
  if (!c.transactionId) {
    const txMatch = text.trim().match(/0x[0-9a-fA-F]{60,}/i);
    if (txMatch) c.transactionId = txMatch[0];
    else if (/no transaction|no tx|don.t have|dont have|no hash|n\/a/i.test(t)) c.transactionId = "Not provided";
  }

  // Amount detection
  if (!c.amount) {
    const tAmt = text.trim().toLowerCase();
    if (/^(no|none|n\/a|na|not sure|unknown|nothing|no amount|i don.t know|dont know)$/.test(tAmt)) {
      c.amount = "Not specified";
    } else if (/[\d,.]+\s*[a-zA-Z]+/.test(text) && !/^0x/i.test(text.trim())) {
      const m = text.match(/[\d,.]+\s*[a-zA-Z]+/);
      if (m) c.amount = m[0].trim();
    } else if (/\$[\d,.]+/.test(text)) {
      const m = text.match(/\$[\d,.]+/);
      if (m) c.amount = m[0].trim();
    } else if (/^[\d,.]+$/.test(tAmt)) {
      c.amount = text.trim();
    } else if (tAmt.length > 3 && tAmt.length < 40 && /^[a-z][a-z\s]*(coin|token|swap|inu|finance|protocol|dao|cash|usd)?$/i.test(tAmt) && !["metamask","coinbase","phantom","ledger","trezor","binance","exodus","rainbow","trustwallet","trust wallet","okx","bybit","kraken"].includes(tAmt) && !/wallet|address|issue|problem|error|help|support/.test(tAmt)) {
      c.amount = text.trim();
    } else if (/[\d,.]+\s*(usd|dollars?|worth)/i.test(text)) {
      const m = text.match(/[\d,.]+\s*(usd|dollars?|worth)/i);
      if (m) c.amount = m[0].trim();
    }
  }

  // Duration detection
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

// ─── Junk Message Detection ────────────────────────────────────────────────
function isJunk(text) {
  const t = text.trim().toLowerCase();
  if (t.length <= 1) return true;
  if (/^(.){3,}$/.test(t)) return true;
  if (/^[b-df-hj-np-tv-z]{4,}$/i.test(t)) return true;
  const junk = ["ok","okay","k","kk","lol","lmao","haha","idk","um","uh","hmm","test","...","??","fine","good","nice","cool","great","sure","yep","nope","yeah","nah"];
  return junk.includes(t);
}

// ─── Greeting Detection ────────────────────────────────────────────────────
function isGreeting(text) {
  const t = text.trim().toLowerCase();
  const greetings = ["hi","hey","hello","hii","heyyy","good morning","good afternoon","good evening","morning","afternoon","howdy","sup","yo","whats up","what's up"];
  return greetings.some(g => t === g || t === g + "!" || t === g + "?");
}

// ─── Gemini AI Enhancement (Optional) ─────────────────────────────────────
async function tryGemini(conversationHistory, geminiKey) {
  if (!geminiKey) return null;
  try {
    const prompt = `You are a crypto support assistant. Analyze this conversation and extract any relevant details the user has shared.

Conversation:
${conversationHistory}

Respond ONLY with the following JSON and nothing else:
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
    console.log("Gemini enhancement skipped:", e.message);
    return null;
  }
}

// ─── Panel Builder ─────────────────────────────────────────────────────────
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("Open a Support Ticket 🎫")
    .setDescription("Need assistance? Hit the button below to get started 👇")
    .setColor(0x2b2d31)
    .setAuthor({ name: "Help Desk", iconURL: client.user.displayAvatarURL() });
}
function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_ticket").setLabel("New Ticket").setEmoji("🎫").setStyle(ButtonStyle.Secondary)
  );
}
async function sendPanel(channel) {
  await channel.permissionOverwrites.edit(channel.guild.id, { SendMessages: false, ViewChannel: true }).catch(() => {});
  await channel.send({ embeds: [buildPanelEmbed()], components: [buildPanelRow()] });
}

// ─── Bot Ready ─────────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`✅ Connected as ${client.user.tag}`);
  const guild = client.guilds.cache.get(CONFIG.guildId);
  if (!guild) return console.error("❌ Guild not found.");
  await guild.commands.set([
    { name: "panel", description: "Deploy the ticket panel (admin only)" },
    { name: "tickets", description: "View all active tickets (admin only)" },
    { name: "ticket", description: "Pull up a specific ticket by ID (admin only)", options: [{ name: "id", description: "Ticket ID", type: 3, required: true }] },
    { name: "mystatus", description: "View your own submitted tickets" },
  ]);
  console.log("✅ Slash commands synced.");
});

// ─── Interaction Handler ───────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  const guild = interaction.guild;

  // /panel
  if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
    if (!isAdmin(interaction.member, guild)) return interaction.reply({ content: "❌ Admin access required.", flags: 64 });
    await sendPanel(interaction.channel);
    return interaction.reply({ content: "✅ Ticket panel deployed!", flags: 64 });
  }

  // /tickets
  if (interaction.isChatInputCommand() && interaction.commandName === "tickets") {
    if (!isAdmin(interaction.member, guild)) return interaction.reply({ content: "❌ Admin access required.", flags: 64 });
    const db = loadDB();
    const entries = Object.values(db);
    if (!entries.length) return interaction.reply({ content: "No tickets on record.", flags: 64 });
    const list = entries.slice(-20).map((t) => `${statusEmoji(t.status)} **#${t.id}** *(${t.status})* — <@${t.userId}>`).join("\n");
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle("📋 Ticket Overview (last 20)").setDescription(list).setColor(0x5865f2)], flags: 64 });
  }

  // /ticket
  if (interaction.isChatInputCommand() && interaction.commandName === "ticket") {
    if (!isAdmin(interaction.member, guild)) return interaction.reply({ content: "❌ Admin access required.", flags: 64 });
    const id = interaction.options.getString("id");
    const db = loadDB();
    const ticket = db[id];
    if (!ticket) return interaction.reply({ content: `❌ No ticket found with ID #${id}.`, flags: 64 });
    const c = ticket.collected || {};
    const embed = new EmbedBuilder()
      .setTitle(`🎫 Ticket #${ticket.id}`)
      .setColor(ticket.status === "open" ? 0x57f287 : 0xed4245)
      .addFields(
        { name: "Status", value: `${statusEmoji(ticket.status)} ${ticket.status}`, inline: true },
        { name: "Submitted by", value: `<@${ticket.userId}>`, inline: true },
        { name: "Opened at", value: new Date(ticket.openedAt).toUTCString() },
        { name: "Issue", value: c.issue || "Not provided" },
        { name: "Wallet Type", value: c.walletType || "Not provided", inline: true },
        { name: "Wallet Address", value: c.walletAddress || "Not provided", inline: true },
        { name: "Duration", value: c.duration || "N/A", inline: true },
        { name: "Transaction ID", value: c.transactionId || "N/A", inline: true },
        { name: "Amount", value: c.amount || "N/A", inline: true },
      );
    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // /mystatus
  if (interaction.isChatInputCommand() && interaction.commandName === "mystatus") {
    const db = loadDB();
    const myTickets = Object.values(db).filter((t) => t.userId === interaction.user.id);
    if (!myTickets.length) return interaction.reply({ content: "You haven't submitted any tickets yet.", flags: 64 });
    const list = myTickets.map((t) => `${statusEmoji(t.status)} **#${t.id}** *(${t.status})*`).join("\n");
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle("🎫 Your Tickets").setDescription(list).setColor(0x5865f2)], flags: 64 });
  }

  // ── Open Ticket Button ────────────────────────────────────────────────────
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
        name: `support-${username.toLowerCase().replace(/[^a-z0-9]/g, "")}${ticketId}`,
        type: ChannelType.GuildText,
        parent: CONFIG.supportCategoryId ?? null,
        permissionOverwrites,
      });
    } catch (err) {
      return interaction.editReply({ content: "Unable to open a ticket right now. Please reach out to an admin." });
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
      .setAuthor({ name: "Help Desk", iconURL: client.user.displayAvatarURL() })
      .setTitle("Ticket Opened 🎫")
      .setDescription(`Welcome **${username}** — our support team is here to help.\nPlease describe your issue in as much detail as possible so we can resolve it quickly.`)
      .setColor(0x2b2d31);

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_${ticketId}`).setLabel("Take Ticket").setEmoji("🎫").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`close_${ticketId}`).setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Danger)
    );

    const ticketMsg = await channel.send({ embeds: [ticketEmbed], components: [actionRow] });
    await ticketMsg.pin().catch(() => {});
    await ticketMsg.reply(`Hi <@${interaction.user.id}>! What can we help you with today?`);
    return interaction.editReply({ content: `Your ticket is ready! Head over to <#${channel.id}>` });
  }

  // ── Take Ticket Button ────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("claim_")) {
    if (!isAdmin(interaction.member, guild)) return interaction.reply({ content: "❌ Insufficient permissions.", flags: 64 });
    await interaction.deferReply({ flags: 64 });
    const ticketId = interaction.customId.split("_")[1];
    const db = loadDB();
    if (!db[ticketId]) return interaction.editReply({ content: "❌ Ticket not found." });
    if (db[ticketId].claimedBy) return interaction.editReply({ content: `❌ This ticket is already assigned to <@${db[ticketId].claimedBy}>.` });
    db[ticketId].claimedBy = interaction.user.id;
    saveDB(db);

    const assignedEmbed = new EmbedBuilder()
      .setAuthor({ name: "Help Desk", iconURL: client.user.displayAvatarURL() })
      .setTitle("Agent Assigned ✅")
      .setDescription(`Hey <@${db[ticketId].userId}>, thanks for reaching out!\nYour case is now being handled by **${interaction.user.username}**.`)
      .setColor(0x5865f2);

    const updatedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_${ticketId}`).setLabel("Assigned").setEmoji("✅").setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId(`close_${ticketId}`).setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Danger)
    );

    await interaction.message.edit({ embeds: [assignedEmbed], components: [updatedRow] });
    await interaction.channel.setName(`active-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, "")}`).catch(() => {});
    await interaction.channel.send(`<@${interaction.user.id}> has taken this ticket and will be assisting you.`);

    const agentAvatar = interaction.user.displayAvatarURL({ dynamic: true, size: 128 });
    const sessionEmbed = new EmbedBuilder()
      .setTitle("🎫 Live Session Started")
      .setDescription(
        `**Agent:** <@${interaction.user.id}>\n` +
        `**Response Time:** Under 1 minute\n` +
        `**Status:** 🧍 Under Review\n\n` +
        `🛡️ **Agent Verification**\n` +
        "```css\n✅ Certified Support Specialist```"
      )
      .setThumbnail(agentAvatar)
      .setColor(0x2b2d31)
      .setFooter({ text: `🎫 • Today at ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` });

    await interaction.channel.send({ embeds: [sessionEmbed] });
    await interaction.channel.send("You're now connected with our support team. Please stand by while we review your case.");
    return interaction.editReply({ content: "✅ Ticket successfully assigned to you." });
  }

  // ── Close Ticket Button ───────────────────────────────────────────────────
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
      `Thank you <@${db[ticketId].userId}> for getting in touch — we hope your issue is resolved! 🙏\n\n` +
      `If anything else comes up, feel free to open a new ticket in <#${CONFIG.ticketPanelChannelId}>.\n\n` +
      `This channel will be removed in **10 seconds**.`
    );
    await interaction.reply({ content: "✅ Closing ticket...", flags: 64 });
    setTimeout(async () => { await interaction.channel.delete().catch(() => {}); }, 10000);
  }
});

// ─── New Member Alert ──────────────────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  try {
    const owner = await member.guild.fetchOwner();
    await owner.send(`🔔 **${member.user.username}** just joined **${member.guild.name}**.`);
  } catch { console.log("Could not DM server owner."); }
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
      .setAuthor({ name: `${message.author.username} — Support Agent`, iconURL: message.author.displayAvatarURL() })
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
    await message.channel.send(`Hey **${message.author.username}**! 👋 Hope you're doing well.\n\nI'm here to help you through any crypto-related issues. Go ahead and describe what's happening and I'll get things moving. 🔍`);
    return;
  }

  // ── Junk ──────────────────────────────────────────────────────────────────
  if (isJunk(text)) {
    saveDB(db);
    if (!ticket.collected?.issue) {
      await message.channel.send(`Go ahead and describe your issue, **${message.author.username}** — what exactly is going wrong? 🔍`);
    } else {
      const nextQ = getNextQuestion(ticket.collected, ticket.issueType, message.author.username);
      await message.channel.send(nextQ || `Could you provide a bit more detail? 🔍`);
    }
    return;
  }

  // ── Extract Info ──────────────────────────────────────────────────────────
  ticket.collected = extractInfo(text, ticket.collected || {});
  ticket.conversationHistory = (ticket.conversationHistory || "") + `User: ${text}\n`;

  // ── Classify Issue ────────────────────────────────────────────────────────
  if (!ticket.collected.issue) {
    ticket.collected.issue = text.slice(0, 200);
    ticket.issueType = classifyIssue(text);
  }

  // ── Optional Gemini Enhancement ───────────────────────────────────────────
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

  // ── Determine Next Question ───────────────────────────────────────────────
  const nextQuestion = getNextQuestion(ticket.collected, ticket.issueType, message.author.username);

  if (!nextQuestion) {
    // All info has been gathered
    ticket.infoComplete = true;
    saveDB(db);

    const c = ticket.collected;
    const summaryLines = [
      c.issue          ? `• **Issue:** ${c.issue.slice(0, 100)}` : null,
      c.walletType     ? `• **Wallet:** ${c.walletType}` : null,
      c.walletAddress  ? `• **Address:** \`${c.walletAddress}\`` : null,
      c.duration       ? `• **Duration:** ${c.duration}` : null,
      c.transactionId && c.transactionId !== "Not provided" ? `• **Transaction ID:** \`${c.transactionId}\`` : null,
      c.amount         ? `• **Amount:** ${c.amount}` : null,
    ].filter(Boolean).join("\n");

    await message.channel.send(
      `✅ **Got everything we need, ${message.author.username}!**\n\nHere's a quick recap of what you've shared:\n\n📋 **Case Summary:**\n${summaryLines}\n\n⏳ A member of our team has been notified and will be with you shortly. Please stay in this channel. 🙏`
    );
    return;
  }

  saveDB(db);

  // ── Acknowledgement + Next Question ──────────────────────────────────────
  let ack = "";
  if (!ticket.collected.walletType && tLower.includes("swap")) ack = "Noted — sounds like a swap-related issue. ";
  else if (!ticket.collected.walletType && /lost|missing|gone/i.test(tLower)) ack = "I'm sorry to hear that — let's sort this out. ";
  else if (!ticket.collected.walletType && /hack|scam|stolen/i.test(tLower)) ack = "Understood — we'll treat this as a priority. ";
  else if (!ticket.collected.walletType && /migrat|bridge/i.test(tLower)) ack = "Thanks for the context on the bridge issue. ";
  else if (ticket.collected.walletType && !ticket.collected.walletAddress) ack = `Noted — **${ticket.collected.walletType}** wallet. `;
  else if (ticket.collected.walletAddress && !ticket.collected.duration) ack = "Got it. ";
  else ack = "Appreciate that. ";

  await message.channel.send(`${ack}${nextQuestion}`);
});

// ─── Global Error Handlers ─────────────────────────────────────────────────
client.on("error", (err) => console.error("⚠️ Client error:", err.message));
process.on("unhandledRejection", (err) => console.error("⚠️ Unhandled rejection:", err?.message ?? err));

// ─── Login ─────────────────────────────────────────────────────────────────
client.login(CONFIG.token);
