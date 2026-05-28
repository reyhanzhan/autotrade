// ============================================================================
// PM2 ecosystem — runs the bot and the Next.js dashboard as two services.
// ----------------------------------------------------------------------------
// CRITICAL: the bot is INTENTIONALLY single-instance. Running two copies
// against the same API key would double-fire orders. Do NOT enable cluster
// mode for `autotrade-bot`.
// ----------------------------------------------------------------------------
// Useful commands:
//   pm2 start ecosystem.config.js          # start both apps
//   pm2 logs autotrade-bot                 # tail bot logs
//   pm2 reload autotrade-web               # zero-downtime web reload
//   pm2 save && pm2 startup                # persist across reboots
// ============================================================================

module.exports = {
  apps: [
    {
      name: "autotrade-bot",
      cwd: __dirname,
      script: "bot/dist/index.js",
      exec_mode: "fork",        // single instance — DO NOT change to cluster
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: "300M",
      kill_timeout: 10000,      // give graceful shutdown enough time
      env: { NODE_ENV: "production" },
      out_file: "./logs/bot.out.log",
      error_file: "./logs/bot.err.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "autotrade-web",
      cwd: __dirname + "/web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3001",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "400M",
      env: { NODE_ENV: "production", PORT: "3001", WEB_PORT: "3001" },
      out_file: "../logs/web.out.log",
      error_file: "../logs/web.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
