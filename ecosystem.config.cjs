const path = require('path');

module.exports = {
  apps: [
    {
      name: 'pmci-observer',
      script: 'observer.mjs',
      interpreter: 'node',
      cwd: __dirname,
      env_file: '.env',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s',
      log_file: path.join(__dirname, 'logs/pmci-observer.log'),
      error_file: path.join(__dirname, 'logs/pmci-observer-error.log'),
      time: true,
    },
    {
      name: 'pmci-api',
      script: 'src/api.mjs',
      interpreter: 'node',
      cwd: __dirname,
      env_file: '.env',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s',
      log_file: path.join(__dirname, 'logs/pmci-api.log'),
      error_file: path.join(__dirname, 'logs/pmci-api-error.log'),
      time: true,
    }
  ]
};
