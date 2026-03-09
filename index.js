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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require("discord.js");

const fs = require("fs");

// ─── Config ────────────────────────────────────────────────────────────────
const CONFIG = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  supportCategoryId: process.env.SUPPORT_CATEGORY_ID,
  logChannelId: process.env.LOG_CHANNEL_ID,
  adminRoleId: process.env.ADMIN_ROLE_ID,
  ticketPanelChannelId: process.env.PANEL_CHANNEL_ID,
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

function statusEmoji(status) {
  return { open: "🟢", pending: "🟡", closed: "🔴" }[status] ?? "⚪";
}

function isAdmin(member, guild) {
  return (
    member?.roles.cache.has(CONFIG.adminRoleId) ||
    guild.ownerId === member?.id
  );
}

// ─── Panel Embed ───────────────────────────────────────────────────────────
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("Ticket Creation 📩")
    .setDescription("Please click on the button below to create a ticket 👇")
    .setColor(0x2b2d31)
    .setAuthor({
      name: "Support Ticket",
      iconURL: client.user.displayAvatarURL(),
    });
}

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("open_ticket")
      .setLabel("Create Ticket")
      .setEmoji("📩")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function sendPanel(channel) {
  // Lock channel so only bot can send messages
  await channel.permissionOverwrites.edit(channel.guild.id, {
    SendMessages: false,
    ViewChannel: true,
  }).catch(() => {});
  await channel.send({ embeds: [buildPanelEmbed()], components: [buildPanelRow()] });
}

// ─── Ready ─────────────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const guild = client.guilds.cache.get(CONFIG.guildId);
  if (!guild) return console.error("❌ Guild not found. Check your GUILD_ID.");

  await guild.commands.set([
    { name: "panel", description: "Post the ticket panel (admin only)" },
    { name: "tickets", description: "List all tickets (admin only)" },
    {
      name: "ticket",
      description: "Look up a ticket by ID (admin only)",
      options: [{ name: "id", description: "Ticket ID", type: 3, required: true }],
    },
    { name: "mystatus", description: "Check your open tickets" },
  ]);

  console.log("✅ Slash commands registered.");
});

// ─── Interactions ──────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  const guild = interaction.guild;

  // ── /panel ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
    if (!isAdmin(interaction.member, guild)) {
      return interaction.reply({ content: "❌ Admins only.", flags: 64 });
    }
    await sendPanel(interaction.channel);
    return interaction.reply({ content: "✅ Panel sent!", flags: 64 });
  }

  // ── /tickets ──────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === "tickets") {
    if (!isAdmin(interaction.member, guild)) {
      return interaction.reply({ content: "❌ Admins only.", flags: 64 });
    }
    const db = loadDB();
    const entries = Object.values(db);
    if (!entries.length) return interaction.reply({ content: "No tickets yet.", flags: 64 });

    const list = entries.slice(-20).map(
      (t) => `${statusEmoji(t.status)} **#${t.id}** — ${t.subject} *(${t.status})* — <@${t.userId}>`
    ).join("\n");

    return interaction.reply({
      embeds: [new EmbedBuilder().setTitle("📋 All Tickets (last 20)").setDescription(list).setColor(0x5865f2)],
      flags: 64,
    });
  }

  // ── /ticket <id> ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === "ticket") {
    if (!isAdmin(interaction.member, guild)) {
      return interaction.reply({ content: "❌ Admins only.", flags: 64 });
    }
    const id = interaction.options.getString("id");
    const db = loadDB();
    const ticket = db[id];
    if (!ticket) return interaction.reply({ content: `❌ Ticket #${id} not found.`, flags: 64 });

    const embed = new EmbedBuilder()
      .setTitle(`🎫 Ticket #${ticket.id}`)
      .setColor(ticket.status === "open" ? 0x57f287 : ticket.status === "pending" ? 0xfee75c : 0xed4245)
      .addFields(
        { name: "Subject", value: ticket.subject, inline: true },
        { name: "Status", value: `${statusEmoji(ticket.status)} ${ticket.status}`, inline: true },
        { name: "Opened by", value: `<@${ticket.userId}>`, inline: true },
        { name: "Opened at", value: new Date(ticket.openedAt).toUTCString() },
        { name: "Description", value: ticket.description }
      );

    if (ticket.replies?.length) {
      embed.addFields({
        name: `💬 Replies (${ticket.replies.length})`,
        value: ticket.replies.slice(-5).map((r) => `**${r.author}**: ${r.message}`).join("\n"),
      });
    }

    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // ── /mystatus ─────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === "mystatus") {
    const db = loadDB();
    const myTickets = Object.values(db).filter((t) => t.userId === interaction.user.id);
    if (!myTickets.length) return interaction.reply({ content: "You have no tickets.", flags: 64 });

    const list = myTickets.map(
      (t) => `${statusEmoji(t.status)} **#${t.id}** — ${t.subject} *(${t.status})*`
    ).join("\n");

    return interaction.reply({
      embeds: [new EmbedBuilder().setTitle("🎫 Your Tickets").setDescription(list).setColor(0x5865f2)],
      flags: 64,
    });
  }

  // ── Create Ticket Button ───────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "open_ticket") {
    await interaction.deferReply({ flags: 64 });

    const ticketId = generateTicketId();
    const username = interaction.user.username;

    // Build permission overwrites safely using only string IDs
    const permissionOverwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks] },
    ];
    if (CONFIG.adminRoleId && /^\d+$/.test(CONFIG.adminRoleId)) {
      permissionOverwrites.push({ id: CONFIG.adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    }

    // Create private ticket channel
    let channel;
    try {
      channel = await guild.channels.create({
        name: `ticket-${username.toLowerCase().replace(/[^a-z0-9]/g, "")}${ticketId}`,
        type: ChannelType.GuildText,
        parent: CONFIG.supportCategoryId ?? null,
        permissionOverwrites,
      });
    } catch (err) {
      console.error("Failed to create ticket channel:", err.message);
      return interaction.editReply({ content: "Failed to create ticket. Please contact an admin." });
    }

    // Save ticket
    const db = loadDB();
    db[ticketId] = {
      id: ticketId,
      userId: interaction.user.id,
      subject: "Support Request",
      description: "No description provided.",
      status: "open",
      channelId: channel.id,
      openedAt: Date.now(),
      replies: [],
    };
    saveDB(db);

    // Ticket embed with Claim + Close buttons
    const ticketEmbed = new EmbedBuilder()
      .setAuthor({ name: "Support Ticket", iconURL: client.user.displayAvatarURL() })
      .setTitle("Ticket Created 📩")
      .setDescription(
        `Thanks **${username}** for contacting the support team.\n` +
        `Please explain your case so we can help you as quickly as possible.`
      )
      .setColor(0x2b2d31);

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_${ticketId}`).setLabel("Claim").setEmoji("📩").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`close_${ticketId}`).setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Danger)
    );

    const ticketMsg = await channel.send({ embeds: [ticketEmbed], components: [actionRow] });
    await ticketMsg.pin().catch(() => {});

    // Greeting to user
    await channel.send(`Hello <@${interaction.user.id}>, how may I assist you today? Please describe your issue below 👇`);

    // Ping admins then auto-delete so user doesn't see it
    if (CONFIG.adminRoleId) {
      const pingMsg = await channel.send({
        content: `<@&${CONFIG.adminRoleId}> 🔔 New ticket from **${username}**. Please **Claim** it to get started.`,
        allowedMentions: { roles: [CONFIG.adminRoleId] },
      });
      setTimeout(() => pingMsg.delete().catch(() => {}), 5000);
    }

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Ticket Created!")
          .setDescription(`Your private ticket has been created.

👉 Click here to go to your ticket: <#${channel.id}>`)
          .setColor(0x57f287)
      ]
    });
  }

  // ── Claim Button ───────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("claim_")) {
    if (!isAdmin(interaction.member, guild)) {
      return interaction.reply({ content: "❌ You do not have permission to claim tickets.", flags: 64 });
    }

    // Defer immediately to prevent Unknown interaction timeout
    await interaction.deferReply({ flags: 64 });

    const ticketId = interaction.customId.split("_")[1];
    const db = loadDB();
    if (!db[ticketId]) return interaction.editReply({ content: "❌ Ticket not found." });
    if (db[ticketId].claimedBy) {
      return interaction.editReply({ content: `❌ Already claimed by <@${db[ticketId].claimedBy}>.` });
    }

    db[ticketId].claimedBy = interaction.user.id;
    saveDB(db);

    // Update embed
    const claimedEmbed = new EmbedBuilder()
      .setAuthor({ name: "Support Ticket", iconURL: client.user.displayAvatarURL() })
      .setTitle("Ticket Claimed ✅")
      .setDescription(
        `Thanks <@${db[ticketId].userId}> for contacting the support team.\n` +
        `Your ticket has been assigned to **${interaction.user.username}**.`
      )
      .setColor(0x5865f2);

    const updatedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_${ticketId}`).setLabel("Claimed").setEmoji("✅").setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId(`close_${ticketId}`).setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Danger)
    );

    await interaction.message.edit({ embeds: [claimedEmbed], components: [updatedRow] });

    // Rename channel to claimed-agentname
    await interaction.channel.setName(
      `claimed-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, "")}`
    ).catch(() => {});

    await interaction.channel.send(
      `✅ **${interaction.user.username}** (Support Agent) has been assigned to your ticket <@${db[ticketId].userId}>.\n` +
      `They will assist you shortly! Please describe your issue if you haven't already.`
    );

    return interaction.editReply({ content: "✅ You have claimed this ticket." });
  }

  // ── Close Button ───────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("close_")) {
    if (!isAdmin(interaction.member, guild)) {
      return interaction.reply({ content: "❌ Admins only.", flags: 64 });
    }
    const ticketId = interaction.customId.split("_")[1];
    const db = loadDB();
    if (!db[ticketId]) return interaction.reply({ content: "❌ Ticket not found.", flags: 64 });

    db[ticketId].status = "closed";
    db[ticketId].closedAt = Date.now();
    saveDB(db);

    const closedTicket = db[ticketId];

    // Notify the user via DM that their ticket was closed
    try {
      const ticketUser = await client.users.fetch(closedTicket.userId);
      await ticketUser.send(
        `🔒 Your ticket in **${guild.name}** has been **closed** by **${interaction.user.username}**.\n\n` +
        `Thank you for reaching out! We hope your issue has been resolved 🙏\n\n` +
        `If you need further help, open a **new ticket** anytime.`
      );
    } catch {
      console.log("Could not DM user about ticket closure.");
    }

    await interaction.channel.send(
      `🔒 Ticket closed by **${interaction.user.username}**. The user has been notified via DM.\n\n` +
      `This channel is now **admin-only** for review.`
    );

    await interaction.reply({ content: "✅ Ticket closed. User has been removed from this channel.", flags: 64 });

    setTimeout(async () => {
      try {
        const ticketUserId = db[ticketId]?.userId;

        // Rename to closed-username
        await interaction.channel.setName(
          `closed-${interaction.channel.name.replace(/^(ticket|claimed)-/, "")}`
        ).catch(() => {});

        // Lock @everyone out
        await interaction.channel.permissionOverwrites.edit(interaction.guild.id, {
          ViewChannel: false,
          SendMessages: false,
        }).catch(() => {});

        // Remove the ticket user's access completely
        if (ticketUserId) {
          await interaction.channel.permissionOverwrites.edit(ticketUserId, {
            ViewChannel: false,
            SendMessages: false,
          }).catch(() => {});
        }

        // Keep admin access
        if (CONFIG.adminRoleId) {
          await interaction.channel.permissionOverwrites.edit(CONFIG.adminRoleId, {
            ViewChannel: true,
            SendMessages: true,
          }).catch(() => {});
        }
      } catch (err) {
        console.error("Error closing ticket channel:", err.message);
      }
    }, 5000);
  }
});

// ─── New Member Join ───────────────────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  const guild = member.guild;

  // Notify admin privately via DM only
  try {
    const owner = await guild.fetchOwner();
    await owner.send(
      `🔔 **${member.user.username}** just joined **${guild.name}**.`
    );
  } catch {
    console.log("Could not DM owner for join notification.");
  }
});

// ─── Message Handler ───────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const db = loadDB();
  const guild = message.guild;

  // Admin !reply command — shows admin name and avatar
  if (
    message.content.startsWith("!reply ") &&
    isAdmin(message.member, guild)
  ) {
    const ticket = Object.values(db).find((t) => t.channelId === message.channel.id);
    if (!ticket) return;
    const replyText = message.content.slice(7).trim();
    if (!replyText) return;
    await message.delete().catch(() => {});

    // Send as embed showing admin name + avatar
    const adminEmbed = new EmbedBuilder()
      .setAuthor({
        name: `${message.author.username} (Support Agent)`,
        iconURL: message.author.displayAvatarURL(),
      })
      .setDescription(replyText)
      .setColor(0x5865f2)
      .setTimestamp();

    await message.channel.send({ embeds: [adminEmbed] });

    ticket.replies.push({ author: message.author.tag, message: replyText.slice(0, 300), timestamp: Date.now() });
    saveDB(db);
    return;
  }

  // Find ticket for this channel
  const ticket = Object.values(db).find((t) => t.channelId === message.channel.id);
  if (!ticket || ticket.status === "closed") return;

  // Skip admin messages
  if (isAdmin(message.member, guild)) return;

  // Save message
  ticket.replies.push({ author: message.author.tag, message: message.content.slice(0, 300), timestamp: Date.now() });
  saveDB(db);

  // Count only this specific user's messages (not admin replies, not bot messages)
  const userMessageCount = ticket.replies.filter(
    (r) => r.author === message.author.tag && !r.author.includes("Admin")
  ).length;

  // Once ticket is claimed by admin, stop bot auto-responses
  if (ticket.claimedBy) return;

  await message.channel.sendTyping();
  await new Promise((r) => setTimeout(r, 2500));

  if (userMessageCount === 1) {
    await message.channel.send(
      `Hello **${message.author.username}**! 👋 Please tell me more about your issue so I can assist you better. What seems to be the problem?`
    );
  } else if (userMessageCount === 2) {
    await message.channel.send(
      `Thank you **${message.author.username}**! ✅ We have received your message.\n\n` +
      `⏳ A support agent has been notified and will be with you shortly. Please remain in this ticket.`
    );
  } else if (userMessageCount === 3) {
    await message.channel.send(
      `Thank you for the information **${message.author.username}**! 🙏 To help us resolve your issue as quickly as possible, please answer the following:\n\n` +
      `**1.** What is the name of the issue you are experiencing?\n` +
      `**2.** Can you describe the issue in more detail?\n` +
      `**3.** What happened next after the issue occurred?`
    );
  } else {
    await message.channel.send(
      `Thank you **${message.author.username}**! ✅ We have noted your response.\n\n` +
      `⏳ A support agent has been notified and will be with you shortly. Please remain in this ticket.`
    );
  }
});

// ─── Global Error Handler (prevents crashes) ──────────────────────────────
client.on("error", (err) => console.error("⚠️ Client error:", err.message));
process.on("unhandledRejection", (err) => console.error("⚠️ Unhandled rejection:", err?.message ?? err));

// ─── Login ─────────────────────────────────────────────────────────────────
client.login(CONFIG.token);
