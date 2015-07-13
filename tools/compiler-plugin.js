var archinfo = require('./archinfo.js');
var buildmessage = require('./buildmessage.js');
var buildPluginModule = require('./build-plugin.js');
var colonConverter = require('./colon-converter.js');
var files = require('./files.js');
var compiler = require('./compiler.js');
var linker = require('./linker.js');
var util = require('util');
var _ = require('underscore');
var Profile = require('./profile.js').Profile;
import {sha1} from  './watch.js';
import LRU from 'lru-cache';
import {sourceMapLength} from './utils.js';

const CACHE_SIZE = process.env.METEOR_LINKER_CACHE_SIZE || 1024*1024*100;
const CACHE_DEBUG = !! process.env.METEOR_TEST_PRINT_LINKER_CACHE_DEBUG;

// Cache the (slightly post-processed) results of linker.fullLink.
// XXX BBP implement an on-disk cache too to speed up initial build?
const LINKER_CACHE = new LRU({
  max: CACHE_SIZE,
  // Cache is measured in bytes. We don't care about servePath.
  // Key is JSONification of all options plus all hashes.
  length: function (files) {
    return files.reduce((soFar, current) => {
      return soFar + current.data.length + sourceMapLength(current.sourceMap);
    }, 0);
  }
});


exports.CompilerPluginProcessor = function (options) {
  var self = this;
  self.unibuilds = options.unibuilds;
  self.arch = options.arch;
  self.isopackCache = options.isopackCache;
};
_.extend(exports.CompilerPluginProcessor.prototype, {
  runCompilerPlugins: function () {
    var self = this;
    buildmessage.assertInJob();

    // plugin id -> {sourceProcessor, resourceSlots}
    var sourceProcessorsWithSlots = {};

    var sourceBatches = _.map(self.unibuilds, function (unibuild) {
      return new PackageSourceBatch(unibuild, self);
    });

    // If we failed to match sources with processors, we're done.
    if (buildmessage.jobHasMessages()) {
      return [];
    }

    // Find out which files go with which CompilerPlugins.
    _.each(sourceBatches, function (sourceBatch) {
      _.each(sourceBatch.resourceSlots, function (resourceSlot) {
        var sourceProcessor = resourceSlot.sourceProcessor;
        // Skip non-sources.
        if (! sourceProcessor)
          return;

        if (! _.has(sourceProcessorsWithSlots, sourceProcessor.id)) {
          sourceProcessorsWithSlots[sourceProcessor.id] = {
            sourceProcessor: sourceProcessor,
            resourceSlots: []
          };
        }
        sourceProcessorsWithSlots[sourceProcessor.id].resourceSlots.push(
          resourceSlot);
      });
    });

    // Now actually run the handlers.
    _.each(sourceProcessorsWithSlots, function (data, id) {
      var sourceProcessor = data.sourceProcessor;
      var resourceSlots = data.resourceSlots;
      // XXX HERE

      var jobTitle = [
        "processing files with ",
        sourceProcessor.isopack.name,
        " (for target ", self.arch, ")"
      ].join('');

      Profile.time(jobTitle, () => {
        buildmessage.enterJob({
          title: jobTitle
        }, function () {
          var inputFiles = _.map(resourceSlots, function (resourceSlot) {
            return new InputFile(resourceSlot);
          });

          var markedMethod = buildmessage.markBoundary(
            sourceProcessor.userPlugin.processFilesForTarget.bind(
              sourceProcessor.userPlugin));
          try {
            markedMethod(inputFiles);
          } catch (e) {
            buildmessage.exception(e);
          }
        });
      });
    });

    return sourceBatches;
  }
});

var InputFile = function (resourceSlot) {
  var self = this;
  // We use underscored attributes here because this is user-visible code and we
  // don't want users to be accessing anything that we don't document.
  self._resourceSlot = resourceSlot;
};
util.inherits(InputFile, buildPluginModule.InputFile);
_.extend(InputFile.prototype, {
  getContentsAsBuffer: function () {
    var self = this;
    return self._resourceSlot.inputResource.data;
  },
  getPackageName: function () {
    var self = this;
    return self._resourceSlot.packageSourceBatch.unibuild.pkg.name;
  },
  getPathInPackage: function () {
    var self = this;
    return self._resourceSlot.inputResource.path;
  },
  getFileOptions: function () {
    var self = this;
    // XXX fileOptions only exists on some resources (of type "source"). The JS
    // resources might not have this property.
    return self._resourceSlot.inputResource.fileOptions;
  },
  getArch: function () {
    return this._resourceSlot.packageSourceBatch.processor.arch;
  },
  // XXX BBP this should be available on inputfile type for every plugin type
  getSourceHash: function () {
    return this._resourceSlot.inputResource.hash;
  },
  // XXX BBP make sure that if it was matched by filename, this is null
  getExtension: function () {
    return this._resourceSlot.inputResource.extension;
  },

  /**
   * @summary Returns a list of symbols declared as exports in this target. The
   * result of `api.export('symbol')` calls in target's control file such as
   * package.js.
   * @memberof InputFile
   * @returns {String[]}
   */
  getDeclaredExports: function () {
    var self = this;
    return self._resourceSlot.packageSourceBatch.unibuild.declaredExports;
  },

  /**
   * @summary Returns a relative path that can be used to form error messages or
   * other display properties. Can be used as an input to a source map.
   * @memberof InputFile
   * @returns {String}
   */
  getDisplayPath: function () {
    var self = this;
    return self._resourceSlot.packageSourceBatch.unibuild.pkg._getServePath(self.getPathInPackage());
  },

  /**
   * @summary Web targets only. Add a stylesheet to the document. Not available
   * for linter build plugins.
   * @param {Object} options
   * @param {String} options.path The requested path for the added CSS, may not
   * be satisfied if there are path conflicts.
   * @param {String} options.data The content of the stylesheet that should be
   * added.
   * @param {String|Object} options.sourceMap A stringified JSON
   * sourcemap, in case the stylesheet was generated from a different
   * file.
   * @memberOf InputFile
   * @instance
   */
  addStylesheet: function (options) {
    var self = this;
    // XXX BBP validate input!!
    if (options.sourceMap && typeof options.sourceMap === 'string') {
      // XXX remove an anti-XSSI header? ")]}'\n"
      options.sourceMap = JSON.parse(options.sourceMap);
    }
    self._resourceSlot.addStylesheet(options);
  },
  /**
   * @summary Add JavaScript code. The code added will only see the
   * namespaces imported by this package as runtime dependencies using
   * ['api.use'](#PackageAPI-use). If the file being compiled was added
   * with the bare flag, the resulting JavaScript won't be wrapped in a
   * closure.
   * @param {Object} options
   * @param {String} options.path The path at which the JavaScript file
   * should be inserted, may not be honored in case of path conflicts.
   * @param {String} options.data The code to be added.
   * @param {String|Object} options.sourceMap A stringified JSON
   * sourcemap, in case the JavaScript file was generated from a
   * different file.
   * @memberOf InputFile
   * @instance
   */
  addJavaScript: function (options) {
    var self = this;
    if (options.sourceMap && typeof options.sourceMap === 'string') {
      // XXX remove an anti-XSSI header? ")]}'\n"
      options.sourceMap = JSON.parse(options.sourceMap);
    }
    self._resourceSlot.addJavaScript(options);
  },
  /**
   * @summary Add a file to serve as-is to the browser or to include on
   * the browser, depending on the target. On the web, it will be served
   * at the exact path requested. For server targets, it can be retrieved
   * using `Assets.getText` or `Assets.getBinary`.
   * @param {Object} options
   * @param {String} options.path The path at which to serve the asset.
   * @param {Buffer|String} options.data The data that should be placed in the
   * file.
   * @param {String} [options.hash] Optionally, supply a hash for the output
   * file.
   * @memberOf InputFile
   * @instance
   */
  addAsset: function (options) {
    var self = this;
    self._resourceSlot.addAsset(options);
  },

  /**
   * @summary Works in web targets only. Add markup to the `head` or `body`
   * section of the document.
   * @param  {Object} options
   * @param {String} options.section Which section of the document should
   * be appended to. Can only be "head" or "body".
   * @param {String} options.data The content to append.
   * @memberOf InputFile
   * @instance
   */
  addHtml: function (options) {
    var self = this;
    self._resourceSlot.addHtml(options);
  }
});

// XXX BBP doc
var ResourceSlot = function (unibuildResourceInfo,
                             sourceProcessor,
                             packageSourceBatch) {
  var self = this;
  self.inputResource = unibuildResourceInfo;  // XXX BBP prototype?
  // Everything but JS.
  self.outputResources = [];
  // JS, which gets linked together at the end.
  self.jsOutputResources = [];
  self.sourceProcessor = sourceProcessor;
  self.packageSourceBatch = packageSourceBatch;

  if (self.inputResource.type === "source") {
    if (sourceProcessor) {
      // If we have a sourceProcessor, it will handle the adding of the
      // final processed JavaScript.
    } else if (self.inputResource.extension === "js") {
      // If there is no sourceProcessor for a .js file, add the source
      // directly to the output. #HardcodeJs
      self.addJavaScript({
        // XXX it's a shame to keep converting between Buffer and string, but
        // files.convertToStandardLineEndings only works on strings for now
        data: self.inputResource.data.toString('utf8'),
        path: self.inputResource.path,
        hash: self.inputResource.hash,
        bare: self.inputResource.fileOptions &&
          (self.inputResource.fileOptions.bare ||
           // XXX eventually get rid of backward-compatibility "raw" name
           // XXX COMPAT WITH 0.6.4
           self.inputResource.fileOptions.raw)
      });
    }
  } else {
    if (sourceProcessor) {
      throw Error("sourceProcessor for non-source? " +
                  JSON.stringify(unibuildResourceInfo));
    }
    // Any resource that isn't handled by compiler plugins just gets passed
    // through.
    if (self.inputResource.type === "js") {
      self.jsOutputResources.push(self.inputResource);
    } else {
      self.outputResources.push(self.inputResource);
    }
  }
};
_.extend(ResourceSlot.prototype, {
  // XXX BBP check args
  addStylesheet: function (options) {
    var self = this;
    if (! self.sourceProcessor)
      throw Error("addStylesheet on non-source ResourceSlot?");

    // XXX BBP prototype?
    self.outputResources.push({
      type: "css",
      refreshable: true,
      data: new Buffer(files.convertToStandardLineEndings(options.data), 'utf8'),
      servePath: self.packageSourceBatch.unibuild.pkg._getServePath(
        options.path),
      // XXX BBP convertSourceMapPaths ???
      sourceMap: options.sourceMap
    });
  },
  addJavaScript: function (options) {
    var self = this;
    // #HardcodeJs this gets called by constructor in the "js" case
    if (! self.sourceProcessor && self.inputResource.extension !== "js")
      throw Error("addJavaScript on non-source ResourceSlot?");

    var data = new Buffer(
      files.convertToStandardLineEndings(options.data), 'utf8');
    self.jsOutputResources.push({
      type: "js",
      data: data,
      servePath: self.packageSourceBatch.unibuild.pkg._getServePath(
        options.path),
      // XXX BBP should we allow users to be trusted and specify a hash?
      hash: sha1(data),
      sourceMap: options.sourceMap,
      bare: options.bare
    });
  },
  addAsset: function (options) {
    var self = this;
    if (! self.sourceProcessor)
      throw Error("addAsset on non-source ResourceSlot?");

    if (! (options.data instanceof Buffer)) {
      if (_.isString(options.data)) {
        options.data = new Buffer(options.data);
      } else {
        throw new Error("'data' option to addAsset must be a Buffer or String.");
      }
    }

    // XXX BBP this is partially duplicated in isopack.js
    var outputPath = files.convertToStandardPath(options.path, true);
    var unibuild = self.packageSourceBatch.unibuild;
    var serveRoot;
    if (unibuild.pkg.name) {
      serveRoot = files.pathJoin('/packages/', unibuild.pkg.name);
    } else {
      serveRoot = '/';
    }
    if (! unibuild.name) {
      // XXX hack for app's special folders
      outputPath = outputPath.replace(/^(private|public)\//, '');
    }
    throw Error("assets are apparently broken")  // XXX BBP
    resources.push({
      type: 'asset',
      data: options.data,
      path: outputPath,
      servePath: colonConverter.convert(
        files.pathJoin(inputSourceArch.pkg.serveRoot, relPath)),
      hash: options.hash
    });
  },
  addHtml: function (options) {
    var self = this;
    var unibuild = self.packageSourceBatch.unibuild;

    if (! archinfo.matches(unibuild.arch, "web"))
      throw new Error("Document sections can only be emitted to " +
                      "web targets");
    if (options.section !== "head" && options.section !== "body")
      throw new Error("'section' must be 'head' or 'body'");
    if (typeof options.data !== "string")
      throw new Error("'data' option to appendDocument must be a string");

    self.outputResources.push({
      type: options.section,
      data: new Buffer(files.convertToStandardLineEndings(options.data), 'utf8')
    });
  }
});

// XXX BBP ???
var PackageSourceBatch = function (unibuild, processor) {
  var self = this;
  self.unibuild = unibuild;
  self.processor = processor;
  var sourceProcessorSet = self._getSourceProcessorSet();
  self.resourceSlots = [];
  unibuild.resources.forEach(function (resource) {
    let sourceProcessor = null;
    if (resource.type === "source") {
      var extension = resource.extension;
      if (extension === null) {
        const filename = files.pathBasename(resource.path);
        sourceProcessor = sourceProcessorSet.getByFilename(filename);
        if (! sourceProcessor) {
          buildmessage.error(
            `no plugin found for ${ resource.path } in ` +
              `${ unibuild.pkg.displayName() }; a plugin for ${ filename } ` +
              `was active when it was published but none is now`);
          return;
          // recover by ignoring
        }
      } else {
        sourceProcessor = sourceProcessorSet.getByExtension(extension);
        // If resource.extension === 'js', it's ok for there to be no
        // sourceProcessor, since we #HardcodeJs in ResourceSlot.
        if (! sourceProcessor && extension !== 'js') {
          buildmessage.error(
            `no plugin found for ${ resource.path } in ` +
            `${ unibuild.pkg.displayName() }; a plugin for *.${ extension } ` +
            `was active when it was published but none is now`);
          return;
          // recover by ignoring
        }
      }
    }
    self.resourceSlots.push(new ResourceSlot(resource, sourceProcessor, self));
  });
};
_.extend(PackageSourceBatch.prototype, {
  _getSourceProcessorSet: function () {
    var self = this;
    var isopack = self.unibuild.pkg;
    const activePluginPackages = compiler.getActivePluginPackages(isopack, {
      uses: self.unibuild.uses,
      isopackCache: self.processor.isopackCache
    });
    const sourceProcessorSet = new buildPluginModule.SourceProcessorSet(
      isopack.displayName(), { hardcodeJs: true });

    _.each(activePluginPackages, function (otherPkg) {
      otherPkg.ensurePluginsInitialized();

      sourceProcessorSet.merge(
        otherPkg.sourceProcessors.compiler, {arch: self.processor.arch});
    });

    return sourceProcessorSet;
  },

  // Called by bundler's Target._emitResources.  It returns the actual resources
  // that end up in the program for this package.  By this point, it knows what
  // its dependencies are and what their exports are, so it can set up
  // linker-style imports and exports.
  getResources: Profile("PackageSourceBatch#getResources", function () {
    var self = this;
    buildmessage.assertInJob();

    var flatten = function (arrays) {
      return Array.prototype.concat.apply([], arrays);
    };
    var resources = flatten(_.pluck(self.resourceSlots, 'outputResources'));
    var jsResources = flatten(_.pluck(self.resourceSlots, 'jsOutputResources'));
    Array.prototype.push.apply(resources, self._linkJS(jsResources));
    return resources;
  }),

  _linkJS: Profile("PackageSourceBatch#_linkJS", function (jsResources) {
    var self = this;
    buildmessage.assertInJob();

    var isopackCache = self.processor.isopackCache;
    var bundleArch = self.processor.arch;

    if (! archinfo.matches(bundleArch, self.unibuild.arch))
      throw new Error(
        "unibuild of arch '" + self.unibuild.arch + "' does not support '" +
          bundleArch + "'?");

    // Compute imports by merging the exports of all of the packages we
    // use. Note that in the case of conflicting symbols, later packages get
    // precedence.
    //
    // We don't get imports from unordered dependencies (since they may not be
    // defined yet) or from weak/debugOnly dependencies (because the meaning of
    // a name shouldn't be affected by the non-local decision of whether or not
    // an unrelated package in the target depends on something).
    var imports = {}; // map from symbol to supplying package name

    var addImportsForUnibuild = function (depUnibuild) {
      _.each(depUnibuild.declaredExports, function (symbol) {
        // Slightly hacky implementation of test-only exports.
        if (! symbol.testOnly || self.unibuild.pkg.isTest) {
          imports[symbol.name] = depUnibuild.pkg.name;
        }
      });
    };
    compiler.eachUsedUnibuild({
      dependencies: self.unibuild.uses,
      arch: bundleArch,
      isopackCache: isopackCache,
      skipUnordered: true,
      skipDebugOnly: true
    }, addImportsForUnibuild);

    // Run the linker.
    const isApp = ! self.unibuild.pkg.name;
    const linkerOptions = {
      useGlobalNamespace: isApp,
      // I was confused about this, so I am leaving a comment -- the
      // combinedServePath is either [pkgname].js or [pluginName]:plugin.js.
      // XXX: If we change this, we can get rid of source arch names!
      combinedServePath: isApp ? null :
        "/packages/" + colonConverter.convert(
          self.unibuild.pkg.name +
            (self.unibuild.kind === "main" ? "" : (":" + self.unibuild.kind)) +
            ".js"),
      name: self.unibuild.pkg.name || null,
      declaredExports: _.pluck(self.unibuild.declaredExports, 'name'),
      imports: imports,
      // XXX report an error if there is a package called global-imports
      importStubServePath: isApp && '/packages/global-imports.js',
      includeSourceMapInstructions: archinfo.matches(self.unibuild.arch, "web")
    };

    const cacheKey = JSON.stringify({
      linkerOptions,
      files: jsResources.map((inputFile) => {
        // XXX BBP should this technically depend on inputFile.sourceMap too?
        // that seems slow, or I guess we could hash it.
        return {
          servePath: inputFile.servePath,
          hash: inputFile.hash,
          bare: inputFile.bare
        };
      })
    });

    const cached = LINKER_CACHE.get(cacheKey);
    if (cached) {
      if (CACHE_DEBUG) {
        console.log('LINKER CACHE HIT:', linkerOptions.name, bundleArch);
      }
      return cached;
    }

    if (CACHE_DEBUG) {
      console.log('LINKER CACHE MISS:', linkerOptions.name, bundleArch);
    }

    // nb: linkedFiles might be aliased to an entry in LINKER_CACHE, so don't
    // mutate anything from it.
    var linkedFiles = linker.fullLink(jsResources, linkerOptions);

    // Add each output as a resource
    const ret = linkedFiles.map((file) => {
      const sm = (typeof file.sourceMap === 'string')
        ? JSON.parse(file.sourceMap) : file.sourceMap;
      return {
        type: "js",
        data: new Buffer(file.source, 'utf8'), // XXX encoding
        servePath: file.servePath,
        sourceMap: sm
        // XXX BBP hash? needed for minifiers?
      };
    });
    LINKER_CACHE.set(cacheKey, ret);
    return ret;
  })
});
