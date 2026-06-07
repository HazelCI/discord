const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
} = require("discord.js");

// ─── In-memory tracking store ───────────────────────────────────────────────
// Map<string, { type, id, name, channelId, startedAt, startMessageId }>
const tracked = new Map();

// ─── Roblox API helpers ─────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Resolve a Place ID → Universe ID.
 * Returns the universe ID string, or null on failure.
 */
async function placeToUniverse(placeId) {
  const data = await fetchJSON(
    `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
  );
  if (!data || !data.universeId) return null;
  return String(data.universeId);
}

/**
 * Returns { name, banned } or null on error.
 */
async function checkGame(universeId) {
  const data = await fetchJSON(
    `https://games.roblox.com/v1/games?universeIds=${universeId}`,
  );
  if (!data || !data.data || data.data.length === 0) {
    // If the API returns empty, the game was likely moderated/deleted
    return { name: `Universe ${universeId}`, banned: true };
  }
  const game = data.data[0];
  // A game is considered "banned" if it's no longer playable
  // The API may also return an error/empty for fully deleted games
  return { name: game.name, banned: !game.isPlayable };
}

async function checkPlayer(userId) {
  const data = await fetchJSON(`https://users.roblox.com/v1/users/${userId}`);
  if (!data) return { name: `User ${userId}`, banned: true };
  return {
    name: data.name || data.displayName || `User ${userId}`,
    banned: !!data.isBanned,
  };
}

async function checkItem(assetId) {
  const data = await fetchJSON(
    `https://economy.roblox.com/v2/assets/${assetId}/details`,
  );
  if (!data) return { name: `Asset ${assetId}`, banned: true };
  // Asset is moderated if it shows up as not for sale AND has been moderated
  // or if the API returns nothing (handled above)
  const moderated =
    data.AssetStatus === "Moderated" ||
    data.ContentRatingTypeId === 2 ||
    (data.Description === "" && data.Name === "[ Content Deleted ]");
  return { name: data.Name || `Asset ${assetId}`, banned: moderated };
}

const checkers = {
  game: checkGame,
  player: checkPlayer,
  item: checkItem,
};

// ─── Discord client setup ───────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── Register slash commands ────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("track")
    .setDescription(
      "Start tracking a Roblox game, player, or catalog item for bans",
    )
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("What to track")
        .setRequired(true)
        .addChoices(
          { name: "Game (Place ID)", value: "game" },
          { name: "Player (User ID)", value: "player" },
          { name: "Catalog Item (Asset ID)", value: "item" },
        ),
    )
    .addStringOption((opt) =>
      opt
        .setName("id")
        .setDescription("The Roblox ID to track")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("untrack")
    .setDescription("Stop tracking a Roblox ID")
    .addStringOption((opt) =>
      opt
        .setName("id")
        .setDescription("The Roblox ID to stop tracking")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("list")
    .setDescription("List all currently tracked Roblox IDs"),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.token);
  try {
    console.log("[SETUP] Registering slash commands...");
    await rest.put(Routes.applicationCommands(process.env.clientId), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log("[SETUP] Slash commands registered.");
  } catch (err) {
    console.error("[ERROR] Failed to register commands:", err);
  }
}

// ─── Slash command handler ──────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /track ──
  if (commandName === "track") {
    const type = interaction.options.getString("type");
    let id = interaction.options.getString("id");

    await interaction.deferReply();

    // For games, resolve Place ID → Universe ID automatically
    let resolvedUniverseId = null;
    if (type === "game") {
      resolvedUniverseId = await placeToUniverse(id);
      if (!resolvedUniverseId) {
        return interaction.editReply(
          `❌ Could not resolve Place ID \`${id}\` to a Universe. Double-check the ID.`,
        );
      }
    }

    // Use universe ID for the tracking key & checks, but keep the place ID for display
    const trackingId = type === "game" ? resolvedUniverseId : id;
    const key = `${type}:${trackingId}`;

    if (tracked.has(key)) {
      return interaction.editReply(
        `⚠️ Already tracking **${type}** \`${id}\`.`,
      );
    }

    // Do an initial check to grab the name & current status
    const checker = checkers[type];
    const result = await checker(trackingId);

    if (!result) {
      return interaction.editReply(
        "❌ Could not reach the Roblox API. Double-check the ID.",
      );
    }

    if (result.banned) {
      return interaction.editReply(
        `🔨 **${result.name}** (\`${id}\`) is **already banned/moderated**. Nothing to track.`,
      );
    }

    const embed = new EmbedBuilder()
      .setColor(0x00b0f4)
      .setTitle("📡 Tracking Started")
      .addFields(
        {
          name: "Type",
          value: type.charAt(0).toUpperCase() + type.slice(1),
          inline: true,
        },
        {
          name: "ID",
          value:
            type === "game" ? `${id} (Universe: ${resolvedUniverseId})` : id,
          inline: true,
        },
        { name: "Name", value: result.name, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: "Checking every ~4 minutes" });

    const msg = await interaction.editReply({ embeds: [embed] });

    tracked.set(key, {
      type,
      id: trackingId,
      placeId: type === "game" ? id : null,
      name: result.name,
      channelId: interaction.channelId,
      startedAt: Date.now(),
      startMessageId: msg.id,
    });

    console.log(
      `[TRACK] Started tracking ${type} "${result.name}" (${type === "game" ? `place:${id} → universe:${resolvedUniverseId}` : id}) in #${interaction.channel?.name || interaction.channelId}`,
    );
  }

  // ── /untrack ──
  if (commandName === "untrack") {
    const id = interaction.options.getString("id");
    // Try to find it across all types
    const found = [...tracked.entries()].find(([, v]) => v.id === id);
    if (!found) {
      return interaction.reply({
        content: `⚠️ Not tracking anything with ID \`${id}\`.`,
        ephemeral: true,
      });
    }
    tracked.delete(found[0]);
    console.log(
      `[UNTRACK] Stopped tracking ${found[1].type} "${found[1].name}" (${id})`,
    );
    return interaction.reply(
      `🛑 Stopped tracking **${found[1].name}** (\`${id}\`).`,
    );
  }

  // ── /list ──
  if (commandName === "list") {
    if (tracked.size === 0) {
      return interaction.reply({
        content: "Nothing is being tracked right now.",
        ephemeral: true,
      });
    }

    const lines = [...tracked.values()].map((t) => {
      const elapsed = msToHuman(Date.now() - t.startedAt);
      return `• **${t.name}** — ${t.type} \`${t.id}\` — tracking for ${elapsed}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x00b0f4)
      .setTitle("📋 Currently Tracked")
      .setDescription(lines.join("\n"))
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
});

// ─── Polling loop ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes — generous for rate limits

async function pollAll() {
  if (tracked.size === 0) return;

  console.log(`[POLL] Checking ${tracked.size} tracked item(s)...`);

  // Process sequentially to be extra kind to Roblox rate limits
  for (const [key, entry] of tracked) {
    try {
      const result = await checkers[entry.type](entry.id);
      if (!result) continue; // API hiccup, skip this cycle

      if (result.banned) {
        // 🎉 Ban detected!
        const elapsed = msToHuman(Date.now() - entry.startedAt);
        console.log(
          `[BANNED] ${entry.type} "${entry.name}" (${entry.id}) was banned after ${elapsed}`,
        );

        const channel = client.channels.cache.get(entry.channelId);
        if (channel) {
          const embed = new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("🔨 BAN DETECTED")
            .addFields(
              {
                name: "Type",
                value: entry.type.charAt(0).toUpperCase() + entry.type.slice(1),
                inline: true,
              },
              { name: "ID", value: entry.id, inline: true },
              { name: "Name", value: entry.name, inline: true },
              { name: "Time to Ban", value: elapsed, inline: true },
            )
            .setTimestamp()
            .setFooter({ text: "Tracking has been stopped for this item." });

          // Reply to the original tracking message so it's easy to see the timeline
          try {
            const startMsg = await channel.messages.fetch(entry.startMessageId);
            await startMsg.reply({ embeds: [embed] });
          } catch {
            // Fallback: just send in the channel
            await channel.send({ embeds: [embed] });
          }
        }

        tracked.delete(key);
      }
    } catch (err) {
      console.error(`[ERROR] Failed to check ${key}:`, err.message);
    }

    // Small delay between requests to spread out API calls
    await sleep(1500);
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function msToHuman(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Boot ───────────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`[READY] Logged in as ${client.user.tag}`);
  // Start the polling loop
  setInterval(pollAll, POLL_INTERVAL_MS);
  console.log(`[READY] Polling every ${POLL_INTERVAL_MS / 1000}s`);
});

registerCommands();
client.login(process.env.token);
