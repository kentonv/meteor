Package.describe({
  name: "babel-compiler",
  summary: "Parser/transpiler for ECMAScript 6+ syntax",
  // Tracks the npm version below.  Use wrap numbers to increment
  // without incrementing the npm version.
  version: '5.6.17'
});

Npm.depends({
  'meteor-babel': '0.4.2'
});

Package.onUse(function (api) {
  api.addFiles('babel.js', 'server');
  api.use('check');
  api.export('Babel', 'server');
});
