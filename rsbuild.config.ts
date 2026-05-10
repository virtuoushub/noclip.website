import { defineConfig, type RequestHandler } from '@rsbuild/core';
import { pluginTypeCheck } from '@rsbuild/plugin-type-check';
import { execSync } from 'node:child_process';
import { readdir } from 'node:fs';
import type { ServerResponse } from 'node:http';
import parseUrl from 'parseurl';
import send from 'send';
import { config as loadEnv } from 'dotenv';

let gitCommit = '(unknown)';
try {
  gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {
  console.warn('Failed to fetch Git commit hash', e);
}

// Load environment variables from .env file
loadEnv();
const publicStorageUrl = process.env.PUBLIC_STORAGE_URL || '';
const typecheckMemoryLimit = Number.parseInt(process.env.TSCHECK_MEMORY_LIMIT ?? '4096', 10);

export default defineConfig({
  source: {
    entry: {
      index: './src/main.ts',
      embed: './src/main.ts',
    },
    // Legacy decorators are used with `reflect-metadata`.
    // TODO: Migrate to TypeScript 5.0 / TC39 decorators.
    decorators: {
      version: 'legacy',
    },
    define: {
      __COMMIT_HASH: JSON.stringify(gitCommit),
      'import.meta.env.PUBLIC_STORAGE_URL': JSON.stringify(publicStorageUrl),
    },
  },
  html: {
    template: './src/index.html',
  },
  output: {
    target: 'web',
    // Mark Node.js built-in modules as external.
    externals: ['fs', 'path', 'url'],
    // TODO: These should be converted to use `new URL('./file.wasm', import.meta.url)`
    // so that the bundler can resolve them. In the meantime, they're expected to be
    // at the root.
    copy: [
      { from: 'src/**/*.wasm', to: '[name][ext]' },
      { from: 'rust/pkg/index_bg.wasm', to: 'static/js/[name][ext]' },
      { from: 'node_modules/librw/lib/librw.wasm', to: 'static/js/[name][ext]' },
      { from: 'src/vendor/basis_universal/basis_transcoder.wasm', to: 'static/js/[name][ext]' },
    ],
  },
  // Enable async TypeScript type checking.
  plugins: [
    pluginTypeCheck({
      tsCheckerOptions: {
        typescript: {
          // Lower default memory for dev containers; can be overridden via TSCHECK_MEMORY_LIMIT.
          memoryLimit: Number.isFinite(typecheckMemoryLimit)
            ? typecheckMemoryLimit
            : 4096,
        },
      },
    }),
  ],
  tools: {
    rspack(config) {
      // Some CJS dependencies still reference __dirname in web builds.
      // Use plain mock behavior (without warning) instead of warn-mock.
      if (config.node && typeof config.node === 'object') {
        config.node.__dirname = 'mock';
      } else {
        config.node = { __dirname: 'mock' };
      }
    },
    // Disable standards-compliant class field transforms.
    swc: {
      jsc: {
        transform: {
          useDefineForClassFields: false,
        },
      },
    },
  },
  // Disable fallback to index for 404 responses.
  server: {
    htmlFallback: false,
  },
  // Setup middleware to serve the `data` directory.
  dev: {
    setupMiddlewares: [
      (middlewares, _server) => {
        middlewares.unshift(serveData);
        return middlewares;
      },
    ],
  },
});

// Serve files from the `data` directory.
const serveData: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  const matches = parseUrl(req)?.pathname?.match(/^\/data(\/.*)?$/);
  if (!matches) {
    next();
    return;
  }
  // The `send` package handles Range requests, conditional GET,
  // ETag generation, Cache-Control, Last-Modified, and more.
  const stream = send(req, matches[1] || '', {
    index: false,
    root: 'data',
  });
  stream.on(
    'directory',
    function handleDirectory(
      this: send.SendStream,
      res: ServerResponse,
      path: string,
    ) {
      // Print directory listing
      readdir(path, (err, list) => {
        if (err) return this.error(500, err);
        const filtered = list.filter((file) => !file.startsWith('.'));
        if (filtered.length === 0) return this.error(404);
        res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
        res.end(`${filtered.join('\n')}\n`);
      });
    },
  );
  stream.pipe(res);
};
