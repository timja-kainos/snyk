var yaml = require('js-yaml');
var fs = require('then-fs');
var path = require('path');
var debug = require('debug')('snyk');
var debugPolicy = require('debug')('snyk:protect');
var Promise = require('es6-promise').Promise; // jshint ignore:line
var spinner = require('./spinner');
var semver = require('semver');
var moduleToObject = require('snyk-module');

module.exports = {
  load: load,
  save: save,
  getByVuln: getByVuln,
  match: match,
};

var defaultVersion = 'v1';
var latestParser = function (d) { return d; };

// this is a function to allow our tests and fixtures to change cwd
function defaultFilename() {
  return path.resolve(process.cwd(), '.snyk');
}

// eventually we'll have v2 which will point to latestParser, and v1 will
// need to process the old form of data and upgrade it to v2 structure
var parsers = {
  v1: latestParser,
};

function parse(data) {
  if (!data) {
    data = {};
  }

  if (!data.version) {
    data.version = defaultVersion;
  }

  if (!parsers[data.version]) {
    data.version = defaultVersion;
  }

  return parsers[data.version](data);
}

function load(root, options) {
  if (typeof root === 'object') {
    options = root;
    root = null;
  }

  if (!options) {
    options = {};
  }

  if (options['ignore-policy']) {
    return Promise.resolve({});
  }

  var filename = root ? path.resolve(root, '.snyk') : defaultFilename();

  return fs.readFile(filename, 'utf8').then(function (yamlContent) {
    return parse(yaml.safeLoad(yamlContent));
  });
}

function save(object, root) {
  var filename = root ?
    path.resolve(root, '.snyk') :
    defaultFilename();

  var lbl = 'Creating .snyk policy file...';

  return spinner(lbl).then(function () {
    object.version = defaultVersion;
    return yaml.safeDump(object);
  }).then(function (yaml) {
    return fs.writeFile(filename, yaml);
  }).then(spinner.clear(lbl));
}

function match(vuln, rule) {
  var path = Object.keys(rule)[0];
  // check for an exact match
  var pathMatch = false;
  var from = vuln.from.slice(1);
  if (path.indexOf(from.join(' > ')) !== -1) {
    debug('%s exact match from %s', vuln.id, from);
    pathMatch = true;
  } else if (matchPath(from, path)) {
    pathMatch = true;
  }

  return pathMatch;
}

// matchPath will take the array of dependencies that a vulnerability came from
// and try to match it to a string `path`. The path will look like this:
// express-hbs@0.8.4 > handlebars@3.0.3 > uglify-js@2.3.6
// note that the root package is never part of the path (i.e. jsbin@3.11.31)
// the path can also use `*` as a wildcard _and_ use semver:
// * > uglify-js@2.x
// The matchPath will break the `path` down into it's component parts, and loop
// through trying to get a positive match or not. For full examples of options
// see http://git.io/vCH3N
function matchPath(from, path) {
  var parts = path.split(' > ');
  debugPolicy('checking path: %s vs. %s', path, from);
  var offset = 0;
  var res = parts.every(function (pkg, i) {
    debugPolicy('for %s...(against %s)', pkg, from[i + offset]);
    var fromPkg = from[i + offset] ? moduleToObject(from[i + offset]) : {};

    if (pkg === '*') {
      debugPolicy('star rule');

      // FIXME doesn't handle the rule being `*` alone
      if (!parts[i + 1]) {
        return true;
      }

      var next = moduleToObject(parts[i + 1]);

      // assuming we're not at the end of the rule path, then try to find
      // the next matching package in the chain. So `* > semver` matches
      // `foo > bar > semver`
      if (next) {
        debugPolicy('next', next);
        // move forward until we find a matching package
        for (var j = i; i < parts.length; j++) {
          fromPkg = moduleToObject(from[i + offset]);
          debugPolicy('fromPkg', fromPkg, next);

          if (next.name === fromPkg.name) {
            // adjust for the `i` index incrementing in the next .every call
            offset--;
            debugPolicy('next has a match');
            break;
          }
          debugPolicy('pushing offset');
          offset++;
        }
      }

      return true;
    }

    debugPolicy('next test', pkg, fromPkg);

    if (pkg === from[i + offset]) {
      debugPolicy('exact match');
      return true;
    }

    // if we're missing the @version - add @* so the pkg is foobar@*
    // so we have a good semver range
    if (pkg.indexOf('@') === -1) {
      pkg += '@*';
    }

    var pkgVersion = pkg.split('@').pop();

    if (semver.valid(fromPkg.version) &&
      semver.satisfies(fromPkg.version, pkgVersion)) {
      debugPolicy('semver match');
      return true;
    }

    debugPolicy('failed match');

    return false;
  });
  debugPolicy('result of path test %s: %s', path, res);
  return res;
}

function getByVuln(policy, vuln) {
  var found = null;

  ['ignore', 'patch'].forEach(function (key) {
    Object.keys(policy[key] || []).forEach(function (p) {
      if (p === vuln.id) {
        policy[key][p].forEach(function (rule) {
          if (match(vuln, rule)) {
            found = {
              type: key,
              id: vuln.id,
              rule: vuln.from,
            };
            var rootRule = Object.keys(rule).pop();
            Object.keys(rule[rootRule]).forEach(function (key) {
              found[key] = rule[rootRule][key];
            });
          }
        });
      }
    });
  });

  return found;
}