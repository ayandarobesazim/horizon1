'use strict';

const horizon_server = require('@horizon/server');

const fs = require('fs');
const http = require('http');
const https = require('https');
const logger = horizon_server.logger;
const path = require('path');
const toml = require('toml');
const url = require('url');

const start_rdb_server = require('./utils/start_rdb_server');

const addArguments = (parser) => {
  parser.addArgument([ '--project' ],
    { type: 'string', nargs: '?',
      help: 'Change to this directory before serving' });

  parser.addArgument([ '--bind', '-b' ],
    { type: 'string', action: 'append', metavar: 'HOST',
      help: 'Local hostname to serve horizon on (repeatable).' });

  parser.addArgument([ '--port', '-p' ],
    { type: 'int', metavar: 'PORT',
      help: 'Local port to serve horizon on.' });

  parser.addArgument([ '--connect', '-c' ],
    { type: 'string', metavar: 'HOST:PORT',
      help: 'Host and port of the RethinkDB server to connect to.' });

  parser.addArgument([ '--key-file' ],
    { type: 'string', metavar: 'PATH',
      help: 'Path to the key file to use, defaults to "./key.pem".' });

  parser.addArgument([ '--cert-file' ],
    { type: 'string', metavar: 'PATH',
      help: 'Path to the cert file to use, defaults to "./cert.pem".' });

  parser.addArgument([ '--allow-unauthenticated' ],
    { action: 'storeTrue',
      help: 'Whether to allow unauthenticated Horizon connections.' });

  parser.addArgument([ '--allow-anonymous' ],
    { action: 'storeTrue',
      help: 'Whether to allow anonymous Horizon connections.' });

  parser.addArgument([ '--debug' ],
    { action: 'storeTrue',
      help: 'Enable debug logging.' });

  parser.addArgument([ '--insecure' ],
    { action: 'storeTrue',
      help: 'Serve insecure websockets, ignore --key-file and ' +
      '--cert-file.' });

  parser.addArgument([ '--start-rethinkdb' ],
    { action: 'storeTrue',
      help: 'Start up a RethinkDB server in the current directory' });

  parser.addArgument([ '--auto-create-table' ],
    { action: 'storeTrue',
      help: 'Create tables used by requests if they do not exist.' });

  parser.addArgument([ '--auto-create-index' ],
    { action: 'storeTrue',
      help: 'Create indexes used by requests if they do not exist.' });

  parser.addArgument([ '--serve-static' ],
    { type: 'string',
      nargs: '?',
      metavar: 'PATH',
      help: 'Serve static files from a directory, defaults to "./dist".' });

  parser.addArgument([ '--dev' ],
    { action: 'storeTrue',
      help: 'Runs the server in development mode, this sets ' +
      '--debug, ' +
      '--insecure, ' +
      '--auto-create-tables, ' +
      '--start-rethinkdb, ' +
      '--serve-static, ' +
      'and --auto-create-indexes.' });

  parser.addArgument([ '--config' ],
    { type: 'string', metavar: 'PATH',
      help: 'Path to the config file to use, defaults to ".hzconfig".' });

  parser.addArgument([ '--auth' ],
    { type: 'string', action: 'append', metavar: 'PROVIDER,ID,SECRET', defaultValue: [ ],
      help: 'Auth provider and options comma-separated, e.g. "facebook,<id>,<secret>".' });

  parser.addArgument([ '--auth-redirect' ],
    { type: 'string', metavar: 'URL',
      help: 'The URL to redirect to upon completed authentication, defaults to "/".' });
};

// Simple file server. 404s if file not found, 500 if file error,
// otherwise serve it with a mime-type suggested by its file extension.
const serve_file = (file_path, res) => {
  fs.access(file_path, fs.R_OK | fs.F_OK, (exists) => {
    if (exists) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`File "${file_path}" not found\n`);
    } else {
      fs.readFile(file_path, 'binary', (err, file) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`${err}\n`);
        } else {
          if (file_path.endsWith('.js')) {
            res.writeHead(200, {
              'Content-Type': 'application/javascript' });
          } else if (file_path.endsWith('.html')) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
          } else {
            res.writeHead(200);
          }
          res.end(file, 'binary');
        }
      });
    }
  });
};

const fileServer = (distDir) => (req, res) => {
  const req_path = url.parse(req.url).pathname;
  // Serve client files directly
  if (req_path === '/' || req_path === '') {
    serve_file(path.join(distDir, 'index.html'), res);
  } else if (!req_path.match(/\/horizon\/.*$/)) {
    // All other static files come from the dist directory
    serve_file(path.join(distDir, req_path), res);
  }
  // Fall through otherwise. Should be handled by horizon server
};

const createInsecureServers = (opts) => {
  logger.warn(`Creating insecure HTTP server.`);
  let http_servers = new Set();
  let numReady = 0;
  return new Promise((resolve) => {
    opts.bind.forEach((host) => {
      const srv = new http.Server().listen(opts.port, host);
      http_servers.add(srv);
      if (opts.serve_static) {
        logger.info(`Serving static files from ${opts.serve_static}`);
        srv.on('request', fileServer(opts.serve_static));
      }
      srv.on('listening', () => {
        logger.info(`Listening on ${srv.address().address}:` +
                    `${srv.address().port}.`);
        if (++numReady === http_servers.size) {
          resolve(http_servers);
        }
      });
      srv.on('error', (err) => {
        logger.error(
          `HTTP${opts.insecure ? '' : 'S'} server: ${err}`);
        process.exit(1);
      });
    });
  });
};

const readCertFile = (file) => {
  try {
    return fs.readFileSync(path.resolve(file));
  } catch (err) {
    logger.error(`Could not access file ${file} for running ` +
                `a secure HTTP server.`);
    process.exit(1);
  }
};

const createSecureServers = (opts) => {
  let http_servers = new Set();

  const key = readCertFile(opts.key_file);
  const cert = readCertFile(opts.cert_file);
  let numReady = 0;
  return new Promise((resolve) => {
    opts.bind.forEach((host) => {
      const srv = new https.Server({ key, cert }).listen(opts.port, host);
      http_servers.add(srv);
      if (opts.serve_static) {
        logger.info(`Serving static files from ${opts.serve_static}`);
        srv.on('request', fileServer(opts.serve_static));
      }
      srv.on('listening', () => {
        logger.info(`Listening on ${srv.address().address}:` +
                    `${srv.address().port}.`);
        if (++numReady === http_servers.size) {
          resolve(http_servers);
        }
      });
      srv.on('error', (err) => {
        logger.error(
          `HTTP${opts.insecure ? '' : 'S'} server: ${err}`);
        process.exit(1);
      });
    });
  });
};

const default_config_file = './.hzconfig';

const make_default_config = () => ({

  config: default_config_file,
  debug: false,
  project: null,

  bind: [ 'localhost' ],
  port: 8181,

  start_rethinkdb: false,
  serve_static: null,

  insecure: false,
  key_file: './key.pem',
  cert_file: './cert.pem',

  auto_create_table: false,
  auto_create_index: false,

  rdb_host: 'localhost',
  rdb_port: 28015,

  allow_anonymous: false,
  allow_unauthenticated: false,
  auth_redirect: '/',

  auth: { }
});

const default_config = make_default_config();


const parse_connect = (connect, config) => {
  const host_port = connect.split(':');
  if (host_port.length === 1) {
    config.rdb_host = host_port[0];
  } else if (host_port.length === 2) {
    config.rdb_host = host_port[0];
    config.rdb_port = parseInt(host_port[1]);
    if (isNaN(config.rdb_port) || config.rdb_port < 0 || config.rdb_port > 65535) {
      throw new Error(`Invalid port: "${host_port[1]}".`);
    }
  } else {
    throw new Error(`Expected --connect HOST:PORT, but found "${connect}".`);
  }
};

const read_config_from_file = (config_file) => {
  const config = { auth: { } };

  let file_data;
  if (config_file) {
    // Use specified config file - error if it doesn't exist
    file_data = fs.readFileSync(config_file);
  } else {
    // Try default config file - ignore if anything goes wrong
    try {
      file_data = fs.readFileSync(default_config_file);
    } catch (err) {
      return config;
    }
  }

  const file_config = toml.parse(file_data);
  for (const field in file_config) {
    if (field === 'connect') {
      parse_connect(file_config.connect, config);
    } else if (default_config[field] !== undefined) {
      config[field] = file_config[field];
    } else {
      throw new Error(`Unknown config parameter: "${field}".`);
    }
  }

  return config;
};

const env_regex = /^HZ_([A-Z]+([_]?[A-Z]+)*)$/;
const read_config_from_env = () => {
  const config = { auth: { } };

  for (const env_var in process.env) {
    const matches = env_regex.exec(env_var);
    if (matches && matches[1]) {
      const dest_var_name = matches[1].toLowerCase();
      const path = dest_var_name.split('_');
      let value = process.env[env_var];

      if ([ 'false', 'true' ].indexOf(value.toLowerCase()) !== -1) {
        value = (value.toLowerCase() === 'true');
      }

      if (dest_var_name === 'connect') {
        parse_connect(value, config);
      } else if (dest_var_name === 'bind') {
        config[dest_var_name] = value.split(',');
      } else if (path[0] === 'auth' && path.length === 3) {
        config.auth[path[1]] = config.auth[path[1]] || { };

        if (path[2] === 'id') {
          config.auth[path[1]].id = value;
        } else if (path[2] === 'secret') {
          config.auth[path[1]].secret = value;
        }
      } else if (default_config[dest_var_name] !== undefined) {
        config[dest_var_name] = value;
      }
    }
  }

  return config;
};

const read_config_from_flags = (parsed) => {
  const config = { auth: { } };

  // Dev mode
  if (parsed.dev) {
    config.debug = true;
    config.allow_unauthenticated = true;
    config.insecure = true;
    config.start_rethinkdb = true;
    config.auto_create_table = true;
    config.auto_create_index = true;
    config.serve_static = 'dist';
  }

  if (parsed.project !== null) {
    config.project = parsed.project;
  }

  // Simple boolean flags
  const bool_flags = [ 'debug',
                       'insecure',
                       'start_rethinkdb',
                       'auto_create_index',
                       'auto_create_table',
                       'allow_unauthenticated',
                       'allow_anonymous',
                       'auth_redirect' ];

  bool_flags.forEach((key) => {
    if (parsed[key]) {
      config[key] = true;
    }
  });

  // Normalize RethinkDB connection options
  if (parsed.connect) {
    parse_connect(parsed.connect, config);
  }

  if (parsed.serve_static !== null) {
    config.serve_static = parsed.serve_static;
  }

  // Normalize horizon socket options
  if (parsed.port !== null) {
    config.port = parsed.port;
  }
  if (parsed.bind !== null) {
    config.bind = parsed.bind;
  }
  if (config.bind && config.bind.indexOf('all') !== -1) {
    config.bind = [ '0.0.0.0' ];
  }

  // Auth options
  parsed.auth.forEach((auth_options) => {
    const params = auth_options.split(',');
    if (params.length === 3) {
      config.auth[params[0]] = { id: params[1], secret: params[2] };
    } else {
      logger.error(`Expected --auth PROVIDER,ID,SECRET, but found "${auth_options}"`);
      parsed.printUsage();
      process.exit(1);
    }
  });

  return config;
};

const merge_configs = (old_config, new_config) => {
  if (new_config.start_rethinkdb && new_config.rdb_host) {
    throw new Error('Cannot provide both --start-rethinkdb and --connect.');
  }

  for (const key in new_config) {
    if (key === 'rdb_host') {
      old_config.start_rethinkdb = false;
    }

    if (key === 'auth') {
      for (const provider in new_config.auth) {
        old_config.auth[provider] = old_config.auth[provider] || { };
        for (const field in new_config.auth[provider]) {
          old_config.auth[provider][field] = new_config.auth[provider][field];
        }
      }
    } else {
      old_config[key] = new_config[key];
    }
  }

  return old_config;
}

// Command-line flags have the highest precedence, followed by environment variables,
// then the config file, and finally the default values.
const processConfig = (parsed) => {
  let config;

  config = make_default_config();
  config = merge_configs(config, read_config_from_file(parsed.config));
  config = merge_configs(config, read_config_from_env());
  config = merge_configs(config, read_config_from_flags(parsed));

  return config;
};

const startHorizonServer = (servers, opts) => {
  logger.info('Starting Horizon...');
  try {
    return new horizon_server.Server(servers, {
      auto_create_table: opts.auto_create_table,
      auto_create_index: opts.auto_create_index,
      rdb_host: opts.rdb_host,
      rdb_port: opts.rdb_port,
      auth: {
        allow_unauthenticated: opts.allow_unauthenticated,
        allow_anonymous: opts.allow_anonymous,
        success_redirect: opts.auth_redirect,
        failure_redirect: opts.auth_redirect,
      },
    });
  } catch (err) {
    logger.error(`Failed creating Horizon server: ${err}`);
    process.exit(1);
  }
};

// Actually serve based on the already validated options
const runCommand = (opts) => {
  if (opts.debug) {
    logger.level = 'debug';
  }

  if (opts.project !== null) {
    try {
      process.chdir(opts.project);
    } catch (err) {
      logger.error(`Failed to find "${opts.project}" project: ${err}`);
      process.exit(1);
    }
  }

  let http_servers;
  let hz_instance;

  const shutdown = () => {
    if (hz_instance) {
      hz_instance.close();
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return (
    opts.insecure ?
      createInsecureServers(opts) : createSecureServers(opts)
  ).then((servers) => {
    http_servers = servers;
    if (opts.start_rethinkdb) {
      return start_rdb_server().then((rdbOpts) => {
        // Don't need to check for host, always localhost.
        opts.rdb_port = rdbOpts.driverPort;
      });
    }
  }).then(() => {
    hz_instance = startHorizonServer(http_servers, opts);
  }).then(() => {
    if (opts.auth) {
      for (const name in opts.auth) {
        const provider = horizon_server.auth[name];
        if (provider) {
          hz_instance.add_auth_provider(provider, extend({ path: name }, opts.auth[name]));
        } else {
          logger.error(`Unrecognized auth provider "${name}"`);
          process.exit(1);
        }
      }
    }
  }).catch((err) => {
    logger.error(`Error starting Horizon Server: ${err}`);
    process.exit(1);
  });
};

module.exports = {
  addArguments,
  processConfig,
  runCommand,
};