Package.describe({
  name: 'ecmascript',
  version: '0.1.0',
  summary: 'Compiler plugin that supports ES2015+ in all .js files',
  documentation: 'README.md'
});

Npm.depends({
  "meteor-promise": "0.2.4"
});

Package.registerBuildPlugin({
  name: 'compile-ecmascript',
  use: ['babel-compiler@5.6.17'],
  sources: ['plugin.js']
});

Package.onUse(function(api) {
  api.use('isobuild:compiler-plugin@1.0.0');
  api.imply('babel-runtime@0.1.0');

  api.addFiles("promise_server.js", "server");
  api.addFiles(
    '.npm/package/node_modules/meteor-promise/promise_client.js',
    'client',
    { bare: true }
  );
  api.export("Promise");
});
