/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {normalizeUrl, posixPath} from '@docusaurus/utils';
import chalk = require('chalk');
import chokidar from 'chokidar';
import express from 'express';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import path from 'path';
import {debounce} from 'lodash';
import openBrowser from 'react-dev-utils/openBrowser';
import {prepareUrls} from 'react-dev-utils/WebpackDevServerUtils';
import errorOverlayMiddleware from 'react-dev-utils/errorOverlayMiddleware';
// import evalSourceMapMiddleware from 'react-dev-utils/evalSourceMapMiddleware';
import evalSourceMapMiddleware from '../webpack/react-dev-utils-webpack5/evalSourceMapMiddleware';
import webpack from 'webpack';
import WebpackDevServer from 'webpack-dev-server';
import merge from 'webpack-merge';
import HotModuleReplacementPlugin from 'webpack/lib/HotModuleReplacementPlugin';
import {load} from '../server';
import {StartCLIOptions} from '@docusaurus/types';
import {STATIC_DIR_NAME} from '../constants';
import createClientConfig from '../webpack/client';
import {
  applyConfigureWebpack,
  applyConfigurePostCss,
  getHttpsConfig,
} from '../webpack/utils';
import {getCLIOptionHost, getCLIOptionPort} from './commandUtils';
import {getTranslationsLocaleDirPath} from '../server/translations/translations';

export default async function start(
  siteDir: string,
  cliOptions: Partial<StartCLIOptions>,
): Promise<void> {
  process.env.NODE_ENV = 'development';
  process.env.BABEL_ENV = 'development';
  console.log(chalk.blue('Starting the development server...'));

  function loadSite() {
    return load(siteDir, {
      customConfigFilePath: cliOptions.config,
      locale: cliOptions.locale,
      localizePath: undefined, // should this be configurable?
    });
  }

  // Process all related files as a prop.
  const props = await loadSite();

  const protocol: string = process.env.HTTPS === 'true' ? 'https' : 'http';

  const host: string = getCLIOptionHost(cliOptions.host);
  const port: number | null = await getCLIOptionPort(cliOptions.port, host);

  if (port === null) {
    process.exit();
  }

  const {baseUrl, headTags, preBodyTags, postBodyTags} = props;
  const urls = prepareUrls(protocol, host, port);
  const openUrl = normalizeUrl([urls.localUrlForBrowser, baseUrl]);

  console.log(
    chalk.cyanBright(`Docusaurus website is running at "${openUrl}".`),
  );

  // Reload files processing.
  const reload = debounce(() => {
    loadSite()
      .then(({baseUrl: newBaseUrl}) => {
        const newOpenUrl = normalizeUrl([urls.localUrlForBrowser, newBaseUrl]);
        if (newOpenUrl !== openUrl) {
          console.log(
            chalk.cyanBright(
              `Docusaurus website is running at "${newOpenUrl}".`,
            ),
          );
        }
      })
      .catch((err) => {
        console.error(chalk.red(err.stack));
      });
  }, 500);
  const {siteConfig, plugins = []} = props;

  const normalizeToSiteDir = (filepath: string) => {
    if (filepath && path.isAbsolute(filepath)) {
      return posixPath(path.relative(siteDir, filepath));
    }
    return posixPath(filepath);
  };

  const pluginPaths = ([] as string[])
    .concat(
      ...plugins
        .map((plugin) => plugin.getPathsToWatch?.() ?? [])
        .filter(Boolean),
    )
    .map(normalizeToSiteDir);

  const pathsToWatch = [
    ...pluginPaths,
    props.siteConfigPath,
    getTranslationsLocaleDirPath({
      siteDir,
      locale: props.i18n.currentLocale,
    }),
  ];

  const fsWatcher = chokidar.watch(pathsToWatch, {
    cwd: siteDir,
    ignoreInitial: true,
    usePolling: !!cliOptions.poll,
    interval: Number.isInteger(cliOptions.poll)
      ? (cliOptions.poll as number)
      : undefined,
  });

  ['add', 'change', 'unlink', 'addDir', 'unlinkDir'].forEach((event) =>
    fsWatcher.on(event, reload),
  );

  let config: webpack.Configuration = merge(createClientConfig(props), {
    plugins: [
      // Generates an `index.html` file with the <script> injected.
      new HtmlWebpackPlugin({
        template: path.resolve(
          __dirname,
          '../client/templates/index.html.template.ejs',
        ),
        // So we can define the position where the scripts are injected.
        inject: false,
        filename: 'index.html',
        title: siteConfig.title,
        headTags,
        preBodyTags,
        postBodyTags,
      }),
      // This is necessary to emit hot updates for webpack-dev-server.
      new HotModuleReplacementPlugin(),
    ],
  });

  // Plugin Lifecycle - configureWebpack and configurePostCss.
  plugins.forEach((plugin) => {
    const {configureWebpack, configurePostCss} = plugin;

    if (configurePostCss) {
      config = applyConfigurePostCss(configurePostCss, config);
    }

    if (configureWebpack) {
      config = applyConfigureWebpack(
        configureWebpack.bind(plugin), // The plugin lifecycle may reference `this`. // TODO remove this implicit api: inject in callback instead
        config,
        false,
        props.siteConfig.webpack?.jsLoader,
        plugin.content,
      );
    }
  });

  // https://webpack.js.org/configuration/dev-server
  const devServerConfig: WebpackDevServer.Configuration = {
    ...{
      compress: true,
      clientLogLevel: 'error',
      hot: true,
      hotOnly: cliOptions.hotOnly,
      // Use 'ws' instead of 'sockjs-node' on server since we're using native
      // websockets in `webpackHotDevClient`.
      transportMode: 'ws',
      // Prevent a WS client from getting injected as we're already including
      // `webpackHotDevClient`.
      injectClient: false,
      quiet: true,
      https: getHttpsConfig(),
      headers: {
        'access-control-allow-origin': '*',
      },
      publicPath: baseUrl,
      watchOptions: {
        poll: cliOptions.poll,

        // Useful options for our own monorepo using symlinks!
        // See https://github.com/webpack/webpack/issues/11612#issuecomment-879259806
        followSymlinks: true,
        ignored: /node_modules\/(?!@docusaurus)/,
      },
      historyApiFallback: {
        rewrites: [{from: /\/*/, to: baseUrl}],
      },
      disableHostCheck: true,
      // Disable overlay on browser since we use CRA's overlay error reporting.
      overlay: false,
      host,
      before: (app, server) => {
        app.use(
          baseUrl,
          express.static(path.resolve(siteDir, STATIC_DIR_NAME)),
        );
        // This lets us fetch source contents from webpack for the error overlay.
        app.use(evalSourceMapMiddleware(server));
        // This lets us open files from the runtime error overlay.
        app.use(errorOverlayMiddleware());
      },
    },
  };
  const compiler = webpack(config);
  if (process.env.E2E_TEST) {
    compiler.hooks.done.tap('done', (stats) => {
      if (stats.hasErrors()) {
        console.log('E2E_TEST: Project has compiler errors.');
        process.exit(1);
      }
      console.log('E2E_TEST: Project can compile.');
      process.exit(0);
    });
  }

  const devServer = new WebpackDevServer(compiler, devServerConfig);
  devServer.listen(port, host, (err) => {
    if (err) {
      console.log(err);
    }
    if (cliOptions.open) {
      openBrowser(openUrl);
    }
  });
  ['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig as NodeJS.Signals, () => {
      devServer.close();
      process.exit();
    });
  });
}
