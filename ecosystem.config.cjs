// PM2 process file: `pm2 start ecosystem.config.cjs` (see amai-infrastructure/deployment/VPS.md)
module.exports = {
  apps: [
    {
      name: "amai-api",
      script: "dist/src/server.js",
      cwd: __dirname,
      env: { NODE_ENV: "production", RUN_WORKER_IN_PROCESS: "false" },
      instances: 1,
      max_memory_restart: "400M",
      kill_timeout: 10000,
      time: true,
    },
    {
      name: "amai-worker",
      script: "dist/src/jobs/worker.js",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      instances: 1,
      max_memory_restart: "300M",
      time: true,
    },
  ],
};
