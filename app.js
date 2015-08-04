(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";

    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw new TypeError("Invalid System.register form for " + entry.name);

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        if (depEntry.module.exports && depEntry.module.exports.__esModule)
          depExports = depEntry.module.exports;
        else
          depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.module.exports;

    if (!module || !entry.declarative && module.__esModule !== true)
      module = { 'default': module, __useDefault: true };

    // return the defined module object
    return modules[name] = module;
  };

  return function(mains, declare) {

    var System;
    var System = {
      register: register, 
      get: load, 
      set: function(name, module) {
        modules[name] = module; 
      },
      newModule: function(module) {
        return module;
      },
      global: global 
    };
    System.set('@empty', {});

    declare(System);

    for (var i = 0; i < mains.length; i++)
      load(mains[i]);
  }

})(typeof window != 'undefined' ? window : global)
/* (['mainModule'], function(System) {
  System.register(...);
}); */

(['src/main'], function(System) {

(function() {
function define(){};  define.amd = {};
(function(global, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = global.document ? factory(global, true) : function(w) {
      if (!w.document) {
        throw new Error("jQuery requires a window with a document");
      }
      return factory(w);
    };
  } else {
    factory(global);
  }
}(typeof window !== "undefined" ? window : this, function(window, noGlobal) {
  var arr = [];
  var slice = arr.slice;
  var concat = arr.concat;
  var push = arr.push;
  var indexOf = arr.indexOf;
  var class2type = {};
  var toString = class2type.toString;
  var hasOwn = class2type.hasOwnProperty;
  var support = {};
  var document = window.document,
      version = "2.1.4",
      jQuery = function(selector, context) {
        return new jQuery.fn.init(selector, context);
      },
      rtrim = /^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g,
      rmsPrefix = /^-ms-/,
      rdashAlpha = /-([\da-z])/gi,
      fcamelCase = function(all, letter) {
        return letter.toUpperCase();
      };
  jQuery.fn = jQuery.prototype = {
    jquery: version,
    constructor: jQuery,
    selector: "",
    length: 0,
    toArray: function() {
      return slice.call(this);
    },
    get: function(num) {
      return num != null ? (num < 0 ? this[num + this.length] : this[num]) : slice.call(this);
    },
    pushStack: function(elems) {
      var ret = jQuery.merge(this.constructor(), elems);
      ret.prevObject = this;
      ret.context = this.context;
      return ret;
    },
    each: function(callback, args) {
      return jQuery.each(this, callback, args);
    },
    map: function(callback) {
      return this.pushStack(jQuery.map(this, function(elem, i) {
        return callback.call(elem, i, elem);
      }));
    },
    slice: function() {
      return this.pushStack(slice.apply(this, arguments));
    },
    first: function() {
      return this.eq(0);
    },
    last: function() {
      return this.eq(-1);
    },
    eq: function(i) {
      var len = this.length,
          j = +i + (i < 0 ? len : 0);
      return this.pushStack(j >= 0 && j < len ? [this[j]] : []);
    },
    end: function() {
      return this.prevObject || this.constructor(null);
    },
    push: push,
    sort: arr.sort,
    splice: arr.splice
  };
  jQuery.extend = jQuery.fn.extend = function() {
    var options,
        name,
        src,
        copy,
        copyIsArray,
        clone,
        target = arguments[0] || {},
        i = 1,
        length = arguments.length,
        deep = false;
    if (typeof target === "boolean") {
      deep = target;
      target = arguments[i] || {};
      i++;
    }
    if (typeof target !== "object" && !jQuery.isFunction(target)) {
      target = {};
    }
    if (i === length) {
      target = this;
      i--;
    }
    for (; i < length; i++) {
      if ((options = arguments[i]) != null) {
        for (name in options) {
          src = target[name];
          copy = options[name];
          if (target === copy) {
            continue;
          }
          if (deep && copy && (jQuery.isPlainObject(copy) || (copyIsArray = jQuery.isArray(copy)))) {
            if (copyIsArray) {
              copyIsArray = false;
              clone = src && jQuery.isArray(src) ? src : [];
            } else {
              clone = src && jQuery.isPlainObject(src) ? src : {};
            }
            target[name] = jQuery.extend(deep, clone, copy);
          } else if (copy !== undefined) {
            target[name] = copy;
          }
        }
      }
    }
    return target;
  };
  jQuery.extend({
    expando: "jQuery" + (version + Math.random()).replace(/\D/g, ""),
    isReady: true,
    error: function(msg) {
      throw new Error(msg);
    },
    noop: function() {},
    isFunction: function(obj) {
      return jQuery.type(obj) === "function";
    },
    isArray: Array.isArray,
    isWindow: function(obj) {
      return obj != null && obj === obj.window;
    },
    isNumeric: function(obj) {
      return !jQuery.isArray(obj) && (obj - parseFloat(obj) + 1) >= 0;
    },
    isPlainObject: function(obj) {
      if (jQuery.type(obj) !== "object" || obj.nodeType || jQuery.isWindow(obj)) {
        return false;
      }
      if (obj.constructor && !hasOwn.call(obj.constructor.prototype, "isPrototypeOf")) {
        return false;
      }
      return true;
    },
    isEmptyObject: function(obj) {
      var name;
      for (name in obj) {
        return false;
      }
      return true;
    },
    type: function(obj) {
      if (obj == null) {
        return obj + "";
      }
      return typeof obj === "object" || typeof obj === "function" ? class2type[toString.call(obj)] || "object" : typeof obj;
    },
    globalEval: function(code) {
      var script,
          indirect = eval;
      code = jQuery.trim(code);
      if (code) {
        if (code.indexOf("use strict") === 1) {
          script = document.createElement("script");
          script.text = code;
          document.head.appendChild(script).parentNode.removeChild(script);
        } else {
          indirect(code);
        }
      }
    },
    camelCase: function(string) {
      return string.replace(rmsPrefix, "ms-").replace(rdashAlpha, fcamelCase);
    },
    nodeName: function(elem, name) {
      return elem.nodeName && elem.nodeName.toLowerCase() === name.toLowerCase();
    },
    each: function(obj, callback, args) {
      var value,
          i = 0,
          length = obj.length,
          isArray = isArraylike(obj);
      if (args) {
        if (isArray) {
          for (; i < length; i++) {
            value = callback.apply(obj[i], args);
            if (value === false) {
              break;
            }
          }
        } else {
          for (i in obj) {
            value = callback.apply(obj[i], args);
            if (value === false) {
              break;
            }
          }
        }
      } else {
        if (isArray) {
          for (; i < length; i++) {
            value = callback.call(obj[i], i, obj[i]);
            if (value === false) {
              break;
            }
          }
        } else {
          for (i in obj) {
            value = callback.call(obj[i], i, obj[i]);
            if (value === false) {
              break;
            }
          }
        }
      }
      return obj;
    },
    trim: function(text) {
      return text == null ? "" : (text + "").replace(rtrim, "");
    },
    makeArray: function(arr, results) {
      var ret = results || [];
      if (arr != null) {
        if (isArraylike(Object(arr))) {
          jQuery.merge(ret, typeof arr === "string" ? [arr] : arr);
        } else {
          push.call(ret, arr);
        }
      }
      return ret;
    },
    inArray: function(elem, arr, i) {
      return arr == null ? -1 : indexOf.call(arr, elem, i);
    },
    merge: function(first, second) {
      var len = +second.length,
          j = 0,
          i = first.length;
      for (; j < len; j++) {
        first[i++] = second[j];
      }
      first.length = i;
      return first;
    },
    grep: function(elems, callback, invert) {
      var callbackInverse,
          matches = [],
          i = 0,
          length = elems.length,
          callbackExpect = !invert;
      for (; i < length; i++) {
        callbackInverse = !callback(elems[i], i);
        if (callbackInverse !== callbackExpect) {
          matches.push(elems[i]);
        }
      }
      return matches;
    },
    map: function(elems, callback, arg) {
      var value,
          i = 0,
          length = elems.length,
          isArray = isArraylike(elems),
          ret = [];
      if (isArray) {
        for (; i < length; i++) {
          value = callback(elems[i], i, arg);
          if (value != null) {
            ret.push(value);
          }
        }
      } else {
        for (i in elems) {
          value = callback(elems[i], i, arg);
          if (value != null) {
            ret.push(value);
          }
        }
      }
      return concat.apply([], ret);
    },
    guid: 1,
    proxy: function(fn, context) {
      var tmp,
          args,
          proxy;
      if (typeof context === "string") {
        tmp = fn[context];
        context = fn;
        fn = tmp;
      }
      if (!jQuery.isFunction(fn)) {
        return undefined;
      }
      args = slice.call(arguments, 2);
      proxy = function() {
        return fn.apply(context || this, args.concat(slice.call(arguments)));
      };
      proxy.guid = fn.guid = fn.guid || jQuery.guid++;
      return proxy;
    },
    now: Date.now,
    support: support
  });
  jQuery.each("Boolean Number String Function Array Date RegExp Object Error".split(" "), function(i, name) {
    class2type["[object " + name + "]"] = name.toLowerCase();
  });
  function isArraylike(obj) {
    var length = "length" in obj && obj.length,
        type = jQuery.type(obj);
    if (type === "function" || jQuery.isWindow(obj)) {
      return false;
    }
    if (obj.nodeType === 1 && length) {
      return true;
    }
    return type === "array" || length === 0 || typeof length === "number" && length > 0 && (length - 1) in obj;
  }
  var Sizzle = (function(window) {
    var i,
        support,
        Expr,
        getText,
        isXML,
        tokenize,
        compile,
        select,
        outermostContext,
        sortInput,
        hasDuplicate,
        setDocument,
        document,
        docElem,
        documentIsHTML,
        rbuggyQSA,
        rbuggyMatches,
        matches,
        contains,
        expando = "sizzle" + 1 * new Date(),
        preferredDoc = window.document,
        dirruns = 0,
        done = 0,
        classCache = createCache(),
        tokenCache = createCache(),
        compilerCache = createCache(),
        sortOrder = function(a, b) {
          if (a === b) {
            hasDuplicate = true;
          }
          return 0;
        },
        MAX_NEGATIVE = 1 << 31,
        hasOwn = ({}).hasOwnProperty,
        arr = [],
        pop = arr.pop,
        push_native = arr.push,
        push = arr.push,
        slice = arr.slice,
        indexOf = function(list, elem) {
          var i = 0,
              len = list.length;
          for (; i < len; i++) {
            if (list[i] === elem) {
              return i;
            }
          }
          return -1;
        },
        booleans = "checked|selected|async|autofocus|autoplay|controls|defer|disabled|hidden|ismap|loop|multiple|open|readonly|required|scoped",
        whitespace = "[\\x20\\t\\r\\n\\f]",
        characterEncoding = "(?:\\\\.|[\\w-]|[^\\x00-\\xa0])+",
        identifier = characterEncoding.replace("w", "w#"),
        attributes = "\\[" + whitespace + "*(" + characterEncoding + ")(?:" + whitespace + "*([*^$|!~]?=)" + whitespace + "*(?:'((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\"|(" + identifier + "))|)" + whitespace + "*\\]",
        pseudos = ":(" + characterEncoding + ")(?:\\((" + "('((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\")|" + "((?:\\\\.|[^\\\\()[\\]]|" + attributes + ")*)|" + ".*" + ")\\)|)",
        rwhitespace = new RegExp(whitespace + "+", "g"),
        rtrim = new RegExp("^" + whitespace + "+|((?:^|[^\\\\])(?:\\\\.)*)" + whitespace + "+$", "g"),
        rcomma = new RegExp("^" + whitespace + "*," + whitespace + "*"),
        rcombinators = new RegExp("^" + whitespace + "*([>+~]|" + whitespace + ")" + whitespace + "*"),
        rattributeQuotes = new RegExp("=" + whitespace + "*([^\\]'\"]*?)" + whitespace + "*\\]", "g"),
        rpseudo = new RegExp(pseudos),
        ridentifier = new RegExp("^" + identifier + "$"),
        matchExpr = {
          "ID": new RegExp("^#(" + characterEncoding + ")"),
          "CLASS": new RegExp("^\\.(" + characterEncoding + ")"),
          "TAG": new RegExp("^(" + characterEncoding.replace("w", "w*") + ")"),
          "ATTR": new RegExp("^" + attributes),
          "PSEUDO": new RegExp("^" + pseudos),
          "CHILD": new RegExp("^:(only|first|last|nth|nth-last)-(child|of-type)(?:\\(" + whitespace + "*(even|odd|(([+-]|)(\\d*)n|)" + whitespace + "*(?:([+-]|)" + whitespace + "*(\\d+)|))" + whitespace + "*\\)|)", "i"),
          "bool": new RegExp("^(?:" + booleans + ")$", "i"),
          "needsContext": new RegExp("^" + whitespace + "*[>+~]|:(even|odd|eq|gt|lt|nth|first|last)(?:\\(" + whitespace + "*((?:-\\d)?\\d*)" + whitespace + "*\\)|)(?=[^-]|$)", "i")
        },
        rinputs = /^(?:input|select|textarea|button)$/i,
        rheader = /^h\d$/i,
        rnative = /^[^{]+\{\s*\[native \w/,
        rquickExpr = /^(?:#([\w-]+)|(\w+)|\.([\w-]+))$/,
        rsibling = /[+~]/,
        rescape = /'|\\/g,
        runescape = new RegExp("\\\\([\\da-f]{1,6}" + whitespace + "?|(" + whitespace + ")|.)", "ig"),
        funescape = function(_, escaped, escapedWhitespace) {
          var high = "0x" + escaped - 0x10000;
          return high !== high || escapedWhitespace ? escaped : high < 0 ? String.fromCharCode(high + 0x10000) : String.fromCharCode(high >> 10 | 0xD800, high & 0x3FF | 0xDC00);
        },
        unloadHandler = function() {
          setDocument();
        };
    try {
      push.apply((arr = slice.call(preferredDoc.childNodes)), preferredDoc.childNodes);
      arr[preferredDoc.childNodes.length].nodeType;
    } catch (e) {
      push = {apply: arr.length ? function(target, els) {
          push_native.apply(target, slice.call(els));
        } : function(target, els) {
          var j = target.length,
              i = 0;
          while ((target[j++] = els[i++])) {}
          target.length = j - 1;
        }};
    }
    function Sizzle(selector, context, results, seed) {
      var match,
          elem,
          m,
          nodeType,
          i,
          groups,
          old,
          nid,
          newContext,
          newSelector;
      if ((context ? context.ownerDocument || context : preferredDoc) !== document) {
        setDocument(context);
      }
      context = context || document;
      results = results || [];
      nodeType = context.nodeType;
      if (typeof selector !== "string" || !selector || nodeType !== 1 && nodeType !== 9 && nodeType !== 11) {
        return results;
      }
      if (!seed && documentIsHTML) {
        if (nodeType !== 11 && (match = rquickExpr.exec(selector))) {
          if ((m = match[1])) {
            if (nodeType === 9) {
              elem = context.getElementById(m);
              if (elem && elem.parentNode) {
                if (elem.id === m) {
                  results.push(elem);
                  return results;
                }
              } else {
                return results;
              }
            } else {
              if (context.ownerDocument && (elem = context.ownerDocument.getElementById(m)) && contains(context, elem) && elem.id === m) {
                results.push(elem);
                return results;
              }
            }
          } else if (match[2]) {
            push.apply(results, context.getElementsByTagName(selector));
            return results;
          } else if ((m = match[3]) && support.getElementsByClassName) {
            push.apply(results, context.getElementsByClassName(m));
            return results;
          }
        }
        if (support.qsa && (!rbuggyQSA || !rbuggyQSA.test(selector))) {
          nid = old = expando;
          newContext = context;
          newSelector = nodeType !== 1 && selector;
          if (nodeType === 1 && context.nodeName.toLowerCase() !== "object") {
            groups = tokenize(selector);
            if ((old = context.getAttribute("id"))) {
              nid = old.replace(rescape, "\\$&");
            } else {
              context.setAttribute("id", nid);
            }
            nid = "[id='" + nid + "'] ";
            i = groups.length;
            while (i--) {
              groups[i] = nid + toSelector(groups[i]);
            }
            newContext = rsibling.test(selector) && testContext(context.parentNode) || context;
            newSelector = groups.join(",");
          }
          if (newSelector) {
            try {
              push.apply(results, newContext.querySelectorAll(newSelector));
              return results;
            } catch (qsaError) {} finally {
              if (!old) {
                context.removeAttribute("id");
              }
            }
          }
        }
      }
      return select(selector.replace(rtrim, "$1"), context, results, seed);
    }
    function createCache() {
      var keys = [];
      function cache(key, value) {
        if (keys.push(key + " ") > Expr.cacheLength) {
          delete cache[keys.shift()];
        }
        return (cache[key + " "] = value);
      }
      return cache;
    }
    function markFunction(fn) {
      fn[expando] = true;
      return fn;
    }
    function assert(fn) {
      var div = document.createElement("div");
      try {
        return !!fn(div);
      } catch (e) {
        return false;
      } finally {
        if (div.parentNode) {
          div.parentNode.removeChild(div);
        }
        div = null;
      }
    }
    function addHandle(attrs, handler) {
      var arr = attrs.split("|"),
          i = attrs.length;
      while (i--) {
        Expr.attrHandle[arr[i]] = handler;
      }
    }
    function siblingCheck(a, b) {
      var cur = b && a,
          diff = cur && a.nodeType === 1 && b.nodeType === 1 && (~b.sourceIndex || MAX_NEGATIVE) - (~a.sourceIndex || MAX_NEGATIVE);
      if (diff) {
        return diff;
      }
      if (cur) {
        while ((cur = cur.nextSibling)) {
          if (cur === b) {
            return -1;
          }
        }
      }
      return a ? 1 : -1;
    }
    function createInputPseudo(type) {
      return function(elem) {
        var name = elem.nodeName.toLowerCase();
        return name === "input" && elem.type === type;
      };
    }
    function createButtonPseudo(type) {
      return function(elem) {
        var name = elem.nodeName.toLowerCase();
        return (name === "input" || name === "button") && elem.type === type;
      };
    }
    function createPositionalPseudo(fn) {
      return markFunction(function(argument) {
        argument = +argument;
        return markFunction(function(seed, matches) {
          var j,
              matchIndexes = fn([], seed.length, argument),
              i = matchIndexes.length;
          while (i--) {
            if (seed[(j = matchIndexes[i])]) {
              seed[j] = !(matches[j] = seed[j]);
            }
          }
        });
      });
    }
    function testContext(context) {
      return context && typeof context.getElementsByTagName !== "undefined" && context;
    }
    support = Sizzle.support = {};
    isXML = Sizzle.isXML = function(elem) {
      var documentElement = elem && (elem.ownerDocument || elem).documentElement;
      return documentElement ? documentElement.nodeName !== "HTML" : false;
    };
    setDocument = Sizzle.setDocument = function(node) {
      var hasCompare,
          parent,
          doc = node ? node.ownerDocument || node : preferredDoc;
      if (doc === document || doc.nodeType !== 9 || !doc.documentElement) {
        return document;
      }
      document = doc;
      docElem = doc.documentElement;
      parent = doc.defaultView;
      if (parent && parent !== parent.top) {
        if (parent.addEventListener) {
          parent.addEventListener("unload", unloadHandler, false);
        } else if (parent.attachEvent) {
          parent.attachEvent("onunload", unloadHandler);
        }
      }
      documentIsHTML = !isXML(doc);
      support.attributes = assert(function(div) {
        div.className = "i";
        return !div.getAttribute("className");
      });
      support.getElementsByTagName = assert(function(div) {
        div.appendChild(doc.createComment(""));
        return !div.getElementsByTagName("*").length;
      });
      support.getElementsByClassName = rnative.test(doc.getElementsByClassName);
      support.getById = assert(function(div) {
        docElem.appendChild(div).id = expando;
        return !doc.getElementsByName || !doc.getElementsByName(expando).length;
      });
      if (support.getById) {
        Expr.find["ID"] = function(id, context) {
          if (typeof context.getElementById !== "undefined" && documentIsHTML) {
            var m = context.getElementById(id);
            return m && m.parentNode ? [m] : [];
          }
        };
        Expr.filter["ID"] = function(id) {
          var attrId = id.replace(runescape, funescape);
          return function(elem) {
            return elem.getAttribute("id") === attrId;
          };
        };
      } else {
        delete Expr.find["ID"];
        Expr.filter["ID"] = function(id) {
          var attrId = id.replace(runescape, funescape);
          return function(elem) {
            var node = typeof elem.getAttributeNode !== "undefined" && elem.getAttributeNode("id");
            return node && node.value === attrId;
          };
        };
      }
      Expr.find["TAG"] = support.getElementsByTagName ? function(tag, context) {
        if (typeof context.getElementsByTagName !== "undefined") {
          return context.getElementsByTagName(tag);
        } else if (support.qsa) {
          return context.querySelectorAll(tag);
        }
      } : function(tag, context) {
        var elem,
            tmp = [],
            i = 0,
            results = context.getElementsByTagName(tag);
        if (tag === "*") {
          while ((elem = results[i++])) {
            if (elem.nodeType === 1) {
              tmp.push(elem);
            }
          }
          return tmp;
        }
        return results;
      };
      Expr.find["CLASS"] = support.getElementsByClassName && function(className, context) {
        if (documentIsHTML) {
          return context.getElementsByClassName(className);
        }
      };
      rbuggyMatches = [];
      rbuggyQSA = [];
      if ((support.qsa = rnative.test(doc.querySelectorAll))) {
        assert(function(div) {
          docElem.appendChild(div).innerHTML = "<a id='" + expando + "'></a>" + "<select id='" + expando + "-\f]' msallowcapture=''>" + "<option selected=''></option></select>";
          if (div.querySelectorAll("[msallowcapture^='']").length) {
            rbuggyQSA.push("[*^$]=" + whitespace + "*(?:''|\"\")");
          }
          if (!div.querySelectorAll("[selected]").length) {
            rbuggyQSA.push("\\[" + whitespace + "*(?:value|" + booleans + ")");
          }
          if (!div.querySelectorAll("[id~=" + expando + "-]").length) {
            rbuggyQSA.push("~=");
          }
          if (!div.querySelectorAll(":checked").length) {
            rbuggyQSA.push(":checked");
          }
          if (!div.querySelectorAll("a#" + expando + "+*").length) {
            rbuggyQSA.push(".#.+[+~]");
          }
        });
        assert(function(div) {
          var input = doc.createElement("input");
          input.setAttribute("type", "hidden");
          div.appendChild(input).setAttribute("name", "D");
          if (div.querySelectorAll("[name=d]").length) {
            rbuggyQSA.push("name" + whitespace + "*[*^$|!~]?=");
          }
          if (!div.querySelectorAll(":enabled").length) {
            rbuggyQSA.push(":enabled", ":disabled");
          }
          div.querySelectorAll("*,:x");
          rbuggyQSA.push(",.*:");
        });
      }
      if ((support.matchesSelector = rnative.test((matches = docElem.matches || docElem.webkitMatchesSelector || docElem.mozMatchesSelector || docElem.oMatchesSelector || docElem.msMatchesSelector)))) {
        assert(function(div) {
          support.disconnectedMatch = matches.call(div, "div");
          matches.call(div, "[s!='']:x");
          rbuggyMatches.push("!=", pseudos);
        });
      }
      rbuggyQSA = rbuggyQSA.length && new RegExp(rbuggyQSA.join("|"));
      rbuggyMatches = rbuggyMatches.length && new RegExp(rbuggyMatches.join("|"));
      hasCompare = rnative.test(docElem.compareDocumentPosition);
      contains = hasCompare || rnative.test(docElem.contains) ? function(a, b) {
        var adown = a.nodeType === 9 ? a.documentElement : a,
            bup = b && b.parentNode;
        return a === bup || !!(bup && bup.nodeType === 1 && (adown.contains ? adown.contains(bup) : a.compareDocumentPosition && a.compareDocumentPosition(bup) & 16));
      } : function(a, b) {
        if (b) {
          while ((b = b.parentNode)) {
            if (b === a) {
              return true;
            }
          }
        }
        return false;
      };
      sortOrder = hasCompare ? function(a, b) {
        if (a === b) {
          hasDuplicate = true;
          return 0;
        }
        var compare = !a.compareDocumentPosition - !b.compareDocumentPosition;
        if (compare) {
          return compare;
        }
        compare = (a.ownerDocument || a) === (b.ownerDocument || b) ? a.compareDocumentPosition(b) : 1;
        if (compare & 1 || (!support.sortDetached && b.compareDocumentPosition(a) === compare)) {
          if (a === doc || a.ownerDocument === preferredDoc && contains(preferredDoc, a)) {
            return -1;
          }
          if (b === doc || b.ownerDocument === preferredDoc && contains(preferredDoc, b)) {
            return 1;
          }
          return sortInput ? (indexOf(sortInput, a) - indexOf(sortInput, b)) : 0;
        }
        return compare & 4 ? -1 : 1;
      } : function(a, b) {
        if (a === b) {
          hasDuplicate = true;
          return 0;
        }
        var cur,
            i = 0,
            aup = a.parentNode,
            bup = b.parentNode,
            ap = [a],
            bp = [b];
        if (!aup || !bup) {
          return a === doc ? -1 : b === doc ? 1 : aup ? -1 : bup ? 1 : sortInput ? (indexOf(sortInput, a) - indexOf(sortInput, b)) : 0;
        } else if (aup === bup) {
          return siblingCheck(a, b);
        }
        cur = a;
        while ((cur = cur.parentNode)) {
          ap.unshift(cur);
        }
        cur = b;
        while ((cur = cur.parentNode)) {
          bp.unshift(cur);
        }
        while (ap[i] === bp[i]) {
          i++;
        }
        return i ? siblingCheck(ap[i], bp[i]) : ap[i] === preferredDoc ? -1 : bp[i] === preferredDoc ? 1 : 0;
      };
      return doc;
    };
    Sizzle.matches = function(expr, elements) {
      return Sizzle(expr, null, null, elements);
    };
    Sizzle.matchesSelector = function(elem, expr) {
      if ((elem.ownerDocument || elem) !== document) {
        setDocument(elem);
      }
      expr = expr.replace(rattributeQuotes, "='$1']");
      if (support.matchesSelector && documentIsHTML && (!rbuggyMatches || !rbuggyMatches.test(expr)) && (!rbuggyQSA || !rbuggyQSA.test(expr))) {
        try {
          var ret = matches.call(elem, expr);
          if (ret || support.disconnectedMatch || elem.document && elem.document.nodeType !== 11) {
            return ret;
          }
        } catch (e) {}
      }
      return Sizzle(expr, document, null, [elem]).length > 0;
    };
    Sizzle.contains = function(context, elem) {
      if ((context.ownerDocument || context) !== document) {
        setDocument(context);
      }
      return contains(context, elem);
    };
    Sizzle.attr = function(elem, name) {
      if ((elem.ownerDocument || elem) !== document) {
        setDocument(elem);
      }
      var fn = Expr.attrHandle[name.toLowerCase()],
          val = fn && hasOwn.call(Expr.attrHandle, name.toLowerCase()) ? fn(elem, name, !documentIsHTML) : undefined;
      return val !== undefined ? val : support.attributes || !documentIsHTML ? elem.getAttribute(name) : (val = elem.getAttributeNode(name)) && val.specified ? val.value : null;
    };
    Sizzle.error = function(msg) {
      throw new Error("Syntax error, unrecognized expression: " + msg);
    };
    Sizzle.uniqueSort = function(results) {
      var elem,
          duplicates = [],
          j = 0,
          i = 0;
      hasDuplicate = !support.detectDuplicates;
      sortInput = !support.sortStable && results.slice(0);
      results.sort(sortOrder);
      if (hasDuplicate) {
        while ((elem = results[i++])) {
          if (elem === results[i]) {
            j = duplicates.push(i);
          }
        }
        while (j--) {
          results.splice(duplicates[j], 1);
        }
      }
      sortInput = null;
      return results;
    };
    getText = Sizzle.getText = function(elem) {
      var node,
          ret = "",
          i = 0,
          nodeType = elem.nodeType;
      if (!nodeType) {
        while ((node = elem[i++])) {
          ret += getText(node);
        }
      } else if (nodeType === 1 || nodeType === 9 || nodeType === 11) {
        if (typeof elem.textContent === "string") {
          return elem.textContent;
        } else {
          for (elem = elem.firstChild; elem; elem = elem.nextSibling) {
            ret += getText(elem);
          }
        }
      } else if (nodeType === 3 || nodeType === 4) {
        return elem.nodeValue;
      }
      return ret;
    };
    Expr = Sizzle.selectors = {
      cacheLength: 50,
      createPseudo: markFunction,
      match: matchExpr,
      attrHandle: {},
      find: {},
      relative: {
        ">": {
          dir: "parentNode",
          first: true
        },
        " ": {dir: "parentNode"},
        "+": {
          dir: "previousSibling",
          first: true
        },
        "~": {dir: "previousSibling"}
      },
      preFilter: {
        "ATTR": function(match) {
          match[1] = match[1].replace(runescape, funescape);
          match[3] = (match[3] || match[4] || match[5] || "").replace(runescape, funescape);
          if (match[2] === "~=") {
            match[3] = " " + match[3] + " ";
          }
          return match.slice(0, 4);
        },
        "CHILD": function(match) {
          match[1] = match[1].toLowerCase();
          if (match[1].slice(0, 3) === "nth") {
            if (!match[3]) {
              Sizzle.error(match[0]);
            }
            match[4] = +(match[4] ? match[5] + (match[6] || 1) : 2 * (match[3] === "even" || match[3] === "odd"));
            match[5] = +((match[7] + match[8]) || match[3] === "odd");
          } else if (match[3]) {
            Sizzle.error(match[0]);
          }
          return match;
        },
        "PSEUDO": function(match) {
          var excess,
              unquoted = !match[6] && match[2];
          if (matchExpr["CHILD"].test(match[0])) {
            return null;
          }
          if (match[3]) {
            match[2] = match[4] || match[5] || "";
          } else if (unquoted && rpseudo.test(unquoted) && (excess = tokenize(unquoted, true)) && (excess = unquoted.indexOf(")", unquoted.length - excess) - unquoted.length)) {
            match[0] = match[0].slice(0, excess);
            match[2] = unquoted.slice(0, excess);
          }
          return match.slice(0, 3);
        }
      },
      filter: {
        "TAG": function(nodeNameSelector) {
          var nodeName = nodeNameSelector.replace(runescape, funescape).toLowerCase();
          return nodeNameSelector === "*" ? function() {
            return true;
          } : function(elem) {
            return elem.nodeName && elem.nodeName.toLowerCase() === nodeName;
          };
        },
        "CLASS": function(className) {
          var pattern = classCache[className + " "];
          return pattern || (pattern = new RegExp("(^|" + whitespace + ")" + className + "(" + whitespace + "|$)")) && classCache(className, function(elem) {
            return pattern.test(typeof elem.className === "string" && elem.className || typeof elem.getAttribute !== "undefined" && elem.getAttribute("class") || "");
          });
        },
        "ATTR": function(name, operator, check) {
          return function(elem) {
            var result = Sizzle.attr(elem, name);
            if (result == null) {
              return operator === "!=";
            }
            if (!operator) {
              return true;
            }
            result += "";
            return operator === "=" ? result === check : operator === "!=" ? result !== check : operator === "^=" ? check && result.indexOf(check) === 0 : operator === "*=" ? check && result.indexOf(check) > -1 : operator === "$=" ? check && result.slice(-check.length) === check : operator === "~=" ? (" " + result.replace(rwhitespace, " ") + " ").indexOf(check) > -1 : operator === "|=" ? result === check || result.slice(0, check.length + 1) === check + "-" : false;
          };
        },
        "CHILD": function(type, what, argument, first, last) {
          var simple = type.slice(0, 3) !== "nth",
              forward = type.slice(-4) !== "last",
              ofType = what === "of-type";
          return first === 1 && last === 0 ? function(elem) {
            return !!elem.parentNode;
          } : function(elem, context, xml) {
            var cache,
                outerCache,
                node,
                diff,
                nodeIndex,
                start,
                dir = simple !== forward ? "nextSibling" : "previousSibling",
                parent = elem.parentNode,
                name = ofType && elem.nodeName.toLowerCase(),
                useCache = !xml && !ofType;
            if (parent) {
              if (simple) {
                while (dir) {
                  node = elem;
                  while ((node = node[dir])) {
                    if (ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1) {
                      return false;
                    }
                  }
                  start = dir = type === "only" && !start && "nextSibling";
                }
                return true;
              }
              start = [forward ? parent.firstChild : parent.lastChild];
              if (forward && useCache) {
                outerCache = parent[expando] || (parent[expando] = {});
                cache = outerCache[type] || [];
                nodeIndex = cache[0] === dirruns && cache[1];
                diff = cache[0] === dirruns && cache[2];
                node = nodeIndex && parent.childNodes[nodeIndex];
                while ((node = ++nodeIndex && node && node[dir] || (diff = nodeIndex = 0) || start.pop())) {
                  if (node.nodeType === 1 && ++diff && node === elem) {
                    outerCache[type] = [dirruns, nodeIndex, diff];
                    break;
                  }
                }
              } else if (useCache && (cache = (elem[expando] || (elem[expando] = {}))[type]) && cache[0] === dirruns) {
                diff = cache[1];
              } else {
                while ((node = ++nodeIndex && node && node[dir] || (diff = nodeIndex = 0) || start.pop())) {
                  if ((ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1) && ++diff) {
                    if (useCache) {
                      (node[expando] || (node[expando] = {}))[type] = [dirruns, diff];
                    }
                    if (node === elem) {
                      break;
                    }
                  }
                }
              }
              diff -= last;
              return diff === first || (diff % first === 0 && diff / first >= 0);
            }
          };
        },
        "PSEUDO": function(pseudo, argument) {
          var args,
              fn = Expr.pseudos[pseudo] || Expr.setFilters[pseudo.toLowerCase()] || Sizzle.error("unsupported pseudo: " + pseudo);
          if (fn[expando]) {
            return fn(argument);
          }
          if (fn.length > 1) {
            args = [pseudo, pseudo, "", argument];
            return Expr.setFilters.hasOwnProperty(pseudo.toLowerCase()) ? markFunction(function(seed, matches) {
              var idx,
                  matched = fn(seed, argument),
                  i = matched.length;
              while (i--) {
                idx = indexOf(seed, matched[i]);
                seed[idx] = !(matches[idx] = matched[i]);
              }
            }) : function(elem) {
              return fn(elem, 0, args);
            };
          }
          return fn;
        }
      },
      pseudos: {
        "not": markFunction(function(selector) {
          var input = [],
              results = [],
              matcher = compile(selector.replace(rtrim, "$1"));
          return matcher[expando] ? markFunction(function(seed, matches, context, xml) {
            var elem,
                unmatched = matcher(seed, null, xml, []),
                i = seed.length;
            while (i--) {
              if ((elem = unmatched[i])) {
                seed[i] = !(matches[i] = elem);
              }
            }
          }) : function(elem, context, xml) {
            input[0] = elem;
            matcher(input, null, xml, results);
            input[0] = null;
            return !results.pop();
          };
        }),
        "has": markFunction(function(selector) {
          return function(elem) {
            return Sizzle(selector, elem).length > 0;
          };
        }),
        "contains": markFunction(function(text) {
          text = text.replace(runescape, funescape);
          return function(elem) {
            return (elem.textContent || elem.innerText || getText(elem)).indexOf(text) > -1;
          };
        }),
        "lang": markFunction(function(lang) {
          if (!ridentifier.test(lang || "")) {
            Sizzle.error("unsupported lang: " + lang);
          }
          lang = lang.replace(runescape, funescape).toLowerCase();
          return function(elem) {
            var elemLang;
            do {
              if ((elemLang = documentIsHTML ? elem.lang : elem.getAttribute("xml:lang") || elem.getAttribute("lang"))) {
                elemLang = elemLang.toLowerCase();
                return elemLang === lang || elemLang.indexOf(lang + "-") === 0;
              }
            } while ((elem = elem.parentNode) && elem.nodeType === 1);
            return false;
          };
        }),
        "target": function(elem) {
          var hash = window.location && window.location.hash;
          return hash && hash.slice(1) === elem.id;
        },
        "root": function(elem) {
          return elem === docElem;
        },
        "focus": function(elem) {
          return elem === document.activeElement && (!document.hasFocus || document.hasFocus()) && !!(elem.type || elem.href || ~elem.tabIndex);
        },
        "enabled": function(elem) {
          return elem.disabled === false;
        },
        "disabled": function(elem) {
          return elem.disabled === true;
        },
        "checked": function(elem) {
          var nodeName = elem.nodeName.toLowerCase();
          return (nodeName === "input" && !!elem.checked) || (nodeName === "option" && !!elem.selected);
        },
        "selected": function(elem) {
          if (elem.parentNode) {
            elem.parentNode.selectedIndex;
          }
          return elem.selected === true;
        },
        "empty": function(elem) {
          for (elem = elem.firstChild; elem; elem = elem.nextSibling) {
            if (elem.nodeType < 6) {
              return false;
            }
          }
          return true;
        },
        "parent": function(elem) {
          return !Expr.pseudos["empty"](elem);
        },
        "header": function(elem) {
          return rheader.test(elem.nodeName);
        },
        "input": function(elem) {
          return rinputs.test(elem.nodeName);
        },
        "button": function(elem) {
          var name = elem.nodeName.toLowerCase();
          return name === "input" && elem.type === "button" || name === "button";
        },
        "text": function(elem) {
          var attr;
          return elem.nodeName.toLowerCase() === "input" && elem.type === "text" && ((attr = elem.getAttribute("type")) == null || attr.toLowerCase() === "text");
        },
        "first": createPositionalPseudo(function() {
          return [0];
        }),
        "last": createPositionalPseudo(function(matchIndexes, length) {
          return [length - 1];
        }),
        "eq": createPositionalPseudo(function(matchIndexes, length, argument) {
          return [argument < 0 ? argument + length : argument];
        }),
        "even": createPositionalPseudo(function(matchIndexes, length) {
          var i = 0;
          for (; i < length; i += 2) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "odd": createPositionalPseudo(function(matchIndexes, length) {
          var i = 1;
          for (; i < length; i += 2) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "lt": createPositionalPseudo(function(matchIndexes, length, argument) {
          var i = argument < 0 ? argument + length : argument;
          for (; --i >= 0; ) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "gt": createPositionalPseudo(function(matchIndexes, length, argument) {
          var i = argument < 0 ? argument + length : argument;
          for (; ++i < length; ) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        })
      }
    };
    Expr.pseudos["nth"] = Expr.pseudos["eq"];
    for (i in {
      radio: true,
      checkbox: true,
      file: true,
      password: true,
      image: true
    }) {
      Expr.pseudos[i] = createInputPseudo(i);
    }
    for (i in {
      submit: true,
      reset: true
    }) {
      Expr.pseudos[i] = createButtonPseudo(i);
    }
    function setFilters() {}
    setFilters.prototype = Expr.filters = Expr.pseudos;
    Expr.setFilters = new setFilters();
    tokenize = Sizzle.tokenize = function(selector, parseOnly) {
      var matched,
          match,
          tokens,
          type,
          soFar,
          groups,
          preFilters,
          cached = tokenCache[selector + " "];
      if (cached) {
        return parseOnly ? 0 : cached.slice(0);
      }
      soFar = selector;
      groups = [];
      preFilters = Expr.preFilter;
      while (soFar) {
        if (!matched || (match = rcomma.exec(soFar))) {
          if (match) {
            soFar = soFar.slice(match[0].length) || soFar;
          }
          groups.push((tokens = []));
        }
        matched = false;
        if ((match = rcombinators.exec(soFar))) {
          matched = match.shift();
          tokens.push({
            value: matched,
            type: match[0].replace(rtrim, " ")
          });
          soFar = soFar.slice(matched.length);
        }
        for (type in Expr.filter) {
          if ((match = matchExpr[type].exec(soFar)) && (!preFilters[type] || (match = preFilters[type](match)))) {
            matched = match.shift();
            tokens.push({
              value: matched,
              type: type,
              matches: match
            });
            soFar = soFar.slice(matched.length);
          }
        }
        if (!matched) {
          break;
        }
      }
      return parseOnly ? soFar.length : soFar ? Sizzle.error(selector) : tokenCache(selector, groups).slice(0);
    };
    function toSelector(tokens) {
      var i = 0,
          len = tokens.length,
          selector = "";
      for (; i < len; i++) {
        selector += tokens[i].value;
      }
      return selector;
    }
    function addCombinator(matcher, combinator, base) {
      var dir = combinator.dir,
          checkNonElements = base && dir === "parentNode",
          doneName = done++;
      return combinator.first ? function(elem, context, xml) {
        while ((elem = elem[dir])) {
          if (elem.nodeType === 1 || checkNonElements) {
            return matcher(elem, context, xml);
          }
        }
      } : function(elem, context, xml) {
        var oldCache,
            outerCache,
            newCache = [dirruns, doneName];
        if (xml) {
          while ((elem = elem[dir])) {
            if (elem.nodeType === 1 || checkNonElements) {
              if (matcher(elem, context, xml)) {
                return true;
              }
            }
          }
        } else {
          while ((elem = elem[dir])) {
            if (elem.nodeType === 1 || checkNonElements) {
              outerCache = elem[expando] || (elem[expando] = {});
              if ((oldCache = outerCache[dir]) && oldCache[0] === dirruns && oldCache[1] === doneName) {
                return (newCache[2] = oldCache[2]);
              } else {
                outerCache[dir] = newCache;
                if ((newCache[2] = matcher(elem, context, xml))) {
                  return true;
                }
              }
            }
          }
        }
      };
    }
    function elementMatcher(matchers) {
      return matchers.length > 1 ? function(elem, context, xml) {
        var i = matchers.length;
        while (i--) {
          if (!matchers[i](elem, context, xml)) {
            return false;
          }
        }
        return true;
      } : matchers[0];
    }
    function multipleContexts(selector, contexts, results) {
      var i = 0,
          len = contexts.length;
      for (; i < len; i++) {
        Sizzle(selector, contexts[i], results);
      }
      return results;
    }
    function condense(unmatched, map, filter, context, xml) {
      var elem,
          newUnmatched = [],
          i = 0,
          len = unmatched.length,
          mapped = map != null;
      for (; i < len; i++) {
        if ((elem = unmatched[i])) {
          if (!filter || filter(elem, context, xml)) {
            newUnmatched.push(elem);
            if (mapped) {
              map.push(i);
            }
          }
        }
      }
      return newUnmatched;
    }
    function setMatcher(preFilter, selector, matcher, postFilter, postFinder, postSelector) {
      if (postFilter && !postFilter[expando]) {
        postFilter = setMatcher(postFilter);
      }
      if (postFinder && !postFinder[expando]) {
        postFinder = setMatcher(postFinder, postSelector);
      }
      return markFunction(function(seed, results, context, xml) {
        var temp,
            i,
            elem,
            preMap = [],
            postMap = [],
            preexisting = results.length,
            elems = seed || multipleContexts(selector || "*", context.nodeType ? [context] : context, []),
            matcherIn = preFilter && (seed || !selector) ? condense(elems, preMap, preFilter, context, xml) : elems,
            matcherOut = matcher ? postFinder || (seed ? preFilter : preexisting || postFilter) ? [] : results : matcherIn;
        if (matcher) {
          matcher(matcherIn, matcherOut, context, xml);
        }
        if (postFilter) {
          temp = condense(matcherOut, postMap);
          postFilter(temp, [], context, xml);
          i = temp.length;
          while (i--) {
            if ((elem = temp[i])) {
              matcherOut[postMap[i]] = !(matcherIn[postMap[i]] = elem);
            }
          }
        }
        if (seed) {
          if (postFinder || preFilter) {
            if (postFinder) {
              temp = [];
              i = matcherOut.length;
              while (i--) {
                if ((elem = matcherOut[i])) {
                  temp.push((matcherIn[i] = elem));
                }
              }
              postFinder(null, (matcherOut = []), temp, xml);
            }
            i = matcherOut.length;
            while (i--) {
              if ((elem = matcherOut[i]) && (temp = postFinder ? indexOf(seed, elem) : preMap[i]) > -1) {
                seed[temp] = !(results[temp] = elem);
              }
            }
          }
        } else {
          matcherOut = condense(matcherOut === results ? matcherOut.splice(preexisting, matcherOut.length) : matcherOut);
          if (postFinder) {
            postFinder(null, results, matcherOut, xml);
          } else {
            push.apply(results, matcherOut);
          }
        }
      });
    }
    function matcherFromTokens(tokens) {
      var checkContext,
          matcher,
          j,
          len = tokens.length,
          leadingRelative = Expr.relative[tokens[0].type],
          implicitRelative = leadingRelative || Expr.relative[" "],
          i = leadingRelative ? 1 : 0,
          matchContext = addCombinator(function(elem) {
            return elem === checkContext;
          }, implicitRelative, true),
          matchAnyContext = addCombinator(function(elem) {
            return indexOf(checkContext, elem) > -1;
          }, implicitRelative, true),
          matchers = [function(elem, context, xml) {
            var ret = (!leadingRelative && (xml || context !== outermostContext)) || ((checkContext = context).nodeType ? matchContext(elem, context, xml) : matchAnyContext(elem, context, xml));
            checkContext = null;
            return ret;
          }];
      for (; i < len; i++) {
        if ((matcher = Expr.relative[tokens[i].type])) {
          matchers = [addCombinator(elementMatcher(matchers), matcher)];
        } else {
          matcher = Expr.filter[tokens[i].type].apply(null, tokens[i].matches);
          if (matcher[expando]) {
            j = ++i;
            for (; j < len; j++) {
              if (Expr.relative[tokens[j].type]) {
                break;
              }
            }
            return setMatcher(i > 1 && elementMatcher(matchers), i > 1 && toSelector(tokens.slice(0, i - 1).concat({value: tokens[i - 2].type === " " ? "*" : ""})).replace(rtrim, "$1"), matcher, i < j && matcherFromTokens(tokens.slice(i, j)), j < len && matcherFromTokens((tokens = tokens.slice(j))), j < len && toSelector(tokens));
          }
          matchers.push(matcher);
        }
      }
      return elementMatcher(matchers);
    }
    function matcherFromGroupMatchers(elementMatchers, setMatchers) {
      var bySet = setMatchers.length > 0,
          byElement = elementMatchers.length > 0,
          superMatcher = function(seed, context, xml, results, outermost) {
            var elem,
                j,
                matcher,
                matchedCount = 0,
                i = "0",
                unmatched = seed && [],
                setMatched = [],
                contextBackup = outermostContext,
                elems = seed || byElement && Expr.find["TAG"]("*", outermost),
                dirrunsUnique = (dirruns += contextBackup == null ? 1 : Math.random() || 0.1),
                len = elems.length;
            if (outermost) {
              outermostContext = context !== document && context;
            }
            for (; i !== len && (elem = elems[i]) != null; i++) {
              if (byElement && elem) {
                j = 0;
                while ((matcher = elementMatchers[j++])) {
                  if (matcher(elem, context, xml)) {
                    results.push(elem);
                    break;
                  }
                }
                if (outermost) {
                  dirruns = dirrunsUnique;
                }
              }
              if (bySet) {
                if ((elem = !matcher && elem)) {
                  matchedCount--;
                }
                if (seed) {
                  unmatched.push(elem);
                }
              }
            }
            matchedCount += i;
            if (bySet && i !== matchedCount) {
              j = 0;
              while ((matcher = setMatchers[j++])) {
                matcher(unmatched, setMatched, context, xml);
              }
              if (seed) {
                if (matchedCount > 0) {
                  while (i--) {
                    if (!(unmatched[i] || setMatched[i])) {
                      setMatched[i] = pop.call(results);
                    }
                  }
                }
                setMatched = condense(setMatched);
              }
              push.apply(results, setMatched);
              if (outermost && !seed && setMatched.length > 0 && (matchedCount + setMatchers.length) > 1) {
                Sizzle.uniqueSort(results);
              }
            }
            if (outermost) {
              dirruns = dirrunsUnique;
              outermostContext = contextBackup;
            }
            return unmatched;
          };
      return bySet ? markFunction(superMatcher) : superMatcher;
    }
    compile = Sizzle.compile = function(selector, match) {
      var i,
          setMatchers = [],
          elementMatchers = [],
          cached = compilerCache[selector + " "];
      if (!cached) {
        if (!match) {
          match = tokenize(selector);
        }
        i = match.length;
        while (i--) {
          cached = matcherFromTokens(match[i]);
          if (cached[expando]) {
            setMatchers.push(cached);
          } else {
            elementMatchers.push(cached);
          }
        }
        cached = compilerCache(selector, matcherFromGroupMatchers(elementMatchers, setMatchers));
        cached.selector = selector;
      }
      return cached;
    };
    select = Sizzle.select = function(selector, context, results, seed) {
      var i,
          tokens,
          token,
          type,
          find,
          compiled = typeof selector === "function" && selector,
          match = !seed && tokenize((selector = compiled.selector || selector));
      results = results || [];
      if (match.length === 1) {
        tokens = match[0] = match[0].slice(0);
        if (tokens.length > 2 && (token = tokens[0]).type === "ID" && support.getById && context.nodeType === 9 && documentIsHTML && Expr.relative[tokens[1].type]) {
          context = (Expr.find["ID"](token.matches[0].replace(runescape, funescape), context) || [])[0];
          if (!context) {
            return results;
          } else if (compiled) {
            context = context.parentNode;
          }
          selector = selector.slice(tokens.shift().value.length);
        }
        i = matchExpr["needsContext"].test(selector) ? 0 : tokens.length;
        while (i--) {
          token = tokens[i];
          if (Expr.relative[(type = token.type)]) {
            break;
          }
          if ((find = Expr.find[type])) {
            if ((seed = find(token.matches[0].replace(runescape, funescape), rsibling.test(tokens[0].type) && testContext(context.parentNode) || context))) {
              tokens.splice(i, 1);
              selector = seed.length && toSelector(tokens);
              if (!selector) {
                push.apply(results, seed);
                return results;
              }
              break;
            }
          }
        }
      }
      (compiled || compile(selector, match))(seed, context, !documentIsHTML, results, rsibling.test(selector) && testContext(context.parentNode) || context);
      return results;
    };
    support.sortStable = expando.split("").sort(sortOrder).join("") === expando;
    support.detectDuplicates = !!hasDuplicate;
    setDocument();
    support.sortDetached = assert(function(div1) {
      return div1.compareDocumentPosition(document.createElement("div")) & 1;
    });
    if (!assert(function(div) {
      div.innerHTML = "<a href='#'></a>";
      return div.firstChild.getAttribute("href") === "#";
    })) {
      addHandle("type|href|height|width", function(elem, name, isXML) {
        if (!isXML) {
          return elem.getAttribute(name, name.toLowerCase() === "type" ? 1 : 2);
        }
      });
    }
    if (!support.attributes || !assert(function(div) {
      div.innerHTML = "<input/>";
      div.firstChild.setAttribute("value", "");
      return div.firstChild.getAttribute("value") === "";
    })) {
      addHandle("value", function(elem, name, isXML) {
        if (!isXML && elem.nodeName.toLowerCase() === "input") {
          return elem.defaultValue;
        }
      });
    }
    if (!assert(function(div) {
      return div.getAttribute("disabled") == null;
    })) {
      addHandle(booleans, function(elem, name, isXML) {
        var val;
        if (!isXML) {
          return elem[name] === true ? name.toLowerCase() : (val = elem.getAttributeNode(name)) && val.specified ? val.value : null;
        }
      });
    }
    return Sizzle;
  })(window);
  jQuery.find = Sizzle;
  jQuery.expr = Sizzle.selectors;
  jQuery.expr[":"] = jQuery.expr.pseudos;
  jQuery.unique = Sizzle.uniqueSort;
  jQuery.text = Sizzle.getText;
  jQuery.isXMLDoc = Sizzle.isXML;
  jQuery.contains = Sizzle.contains;
  var rneedsContext = jQuery.expr.match.needsContext;
  var rsingleTag = (/^<(\w+)\s*\/?>(?:<\/\1>|)$/);
  var risSimple = /^.[^:#\[\.,]*$/;
  function winnow(elements, qualifier, not) {
    if (jQuery.isFunction(qualifier)) {
      return jQuery.grep(elements, function(elem, i) {
        return !!qualifier.call(elem, i, elem) !== not;
      });
    }
    if (qualifier.nodeType) {
      return jQuery.grep(elements, function(elem) {
        return (elem === qualifier) !== not;
      });
    }
    if (typeof qualifier === "string") {
      if (risSimple.test(qualifier)) {
        return jQuery.filter(qualifier, elements, not);
      }
      qualifier = jQuery.filter(qualifier, elements);
    }
    return jQuery.grep(elements, function(elem) {
      return (indexOf.call(qualifier, elem) >= 0) !== not;
    });
  }
  jQuery.filter = function(expr, elems, not) {
    var elem = elems[0];
    if (not) {
      expr = ":not(" + expr + ")";
    }
    return elems.length === 1 && elem.nodeType === 1 ? jQuery.find.matchesSelector(elem, expr) ? [elem] : [] : jQuery.find.matches(expr, jQuery.grep(elems, function(elem) {
      return elem.nodeType === 1;
    }));
  };
  jQuery.fn.extend({
    find: function(selector) {
      var i,
          len = this.length,
          ret = [],
          self = this;
      if (typeof selector !== "string") {
        return this.pushStack(jQuery(selector).filter(function() {
          for (i = 0; i < len; i++) {
            if (jQuery.contains(self[i], this)) {
              return true;
            }
          }
        }));
      }
      for (i = 0; i < len; i++) {
        jQuery.find(selector, self[i], ret);
      }
      ret = this.pushStack(len > 1 ? jQuery.unique(ret) : ret);
      ret.selector = this.selector ? this.selector + " " + selector : selector;
      return ret;
    },
    filter: function(selector) {
      return this.pushStack(winnow(this, selector || [], false));
    },
    not: function(selector) {
      return this.pushStack(winnow(this, selector || [], true));
    },
    is: function(selector) {
      return !!winnow(this, typeof selector === "string" && rneedsContext.test(selector) ? jQuery(selector) : selector || [], false).length;
    }
  });
  var rootjQuery,
      rquickExpr = /^(?:\s*(<[\w\W]+>)[^>]*|#([\w-]*))$/,
      init = jQuery.fn.init = function(selector, context) {
        var match,
            elem;
        if (!selector) {
          return this;
        }
        if (typeof selector === "string") {
          if (selector[0] === "<" && selector[selector.length - 1] === ">" && selector.length >= 3) {
            match = [null, selector, null];
          } else {
            match = rquickExpr.exec(selector);
          }
          if (match && (match[1] || !context)) {
            if (match[1]) {
              context = context instanceof jQuery ? context[0] : context;
              jQuery.merge(this, jQuery.parseHTML(match[1], context && context.nodeType ? context.ownerDocument || context : document, true));
              if (rsingleTag.test(match[1]) && jQuery.isPlainObject(context)) {
                for (match in context) {
                  if (jQuery.isFunction(this[match])) {
                    this[match](context[match]);
                  } else {
                    this.attr(match, context[match]);
                  }
                }
              }
              return this;
            } else {
              elem = document.getElementById(match[2]);
              if (elem && elem.parentNode) {
                this.length = 1;
                this[0] = elem;
              }
              this.context = document;
              this.selector = selector;
              return this;
            }
          } else if (!context || context.jquery) {
            return (context || rootjQuery).find(selector);
          } else {
            return this.constructor(context).find(selector);
          }
        } else if (selector.nodeType) {
          this.context = this[0] = selector;
          this.length = 1;
          return this;
        } else if (jQuery.isFunction(selector)) {
          return typeof rootjQuery.ready !== "undefined" ? rootjQuery.ready(selector) : selector(jQuery);
        }
        if (selector.selector !== undefined) {
          this.selector = selector.selector;
          this.context = selector.context;
        }
        return jQuery.makeArray(selector, this);
      };
  init.prototype = jQuery.fn;
  rootjQuery = jQuery(document);
  var rparentsprev = /^(?:parents|prev(?:Until|All))/,
      guaranteedUnique = {
        children: true,
        contents: true,
        next: true,
        prev: true
      };
  jQuery.extend({
    dir: function(elem, dir, until) {
      var matched = [],
          truncate = until !== undefined;
      while ((elem = elem[dir]) && elem.nodeType !== 9) {
        if (elem.nodeType === 1) {
          if (truncate && jQuery(elem).is(until)) {
            break;
          }
          matched.push(elem);
        }
      }
      return matched;
    },
    sibling: function(n, elem) {
      var matched = [];
      for (; n; n = n.nextSibling) {
        if (n.nodeType === 1 && n !== elem) {
          matched.push(n);
        }
      }
      return matched;
    }
  });
  jQuery.fn.extend({
    has: function(target) {
      var targets = jQuery(target, this),
          l = targets.length;
      return this.filter(function() {
        var i = 0;
        for (; i < l; i++) {
          if (jQuery.contains(this, targets[i])) {
            return true;
          }
        }
      });
    },
    closest: function(selectors, context) {
      var cur,
          i = 0,
          l = this.length,
          matched = [],
          pos = rneedsContext.test(selectors) || typeof selectors !== "string" ? jQuery(selectors, context || this.context) : 0;
      for (; i < l; i++) {
        for (cur = this[i]; cur && cur !== context; cur = cur.parentNode) {
          if (cur.nodeType < 11 && (pos ? pos.index(cur) > -1 : cur.nodeType === 1 && jQuery.find.matchesSelector(cur, selectors))) {
            matched.push(cur);
            break;
          }
        }
      }
      return this.pushStack(matched.length > 1 ? jQuery.unique(matched) : matched);
    },
    index: function(elem) {
      if (!elem) {
        return (this[0] && this[0].parentNode) ? this.first().prevAll().length : -1;
      }
      if (typeof elem === "string") {
        return indexOf.call(jQuery(elem), this[0]);
      }
      return indexOf.call(this, elem.jquery ? elem[0] : elem);
    },
    add: function(selector, context) {
      return this.pushStack(jQuery.unique(jQuery.merge(this.get(), jQuery(selector, context))));
    },
    addBack: function(selector) {
      return this.add(selector == null ? this.prevObject : this.prevObject.filter(selector));
    }
  });
  function sibling(cur, dir) {
    while ((cur = cur[dir]) && cur.nodeType !== 1) {}
    return cur;
  }
  jQuery.each({
    parent: function(elem) {
      var parent = elem.parentNode;
      return parent && parent.nodeType !== 11 ? parent : null;
    },
    parents: function(elem) {
      return jQuery.dir(elem, "parentNode");
    },
    parentsUntil: function(elem, i, until) {
      return jQuery.dir(elem, "parentNode", until);
    },
    next: function(elem) {
      return sibling(elem, "nextSibling");
    },
    prev: function(elem) {
      return sibling(elem, "previousSibling");
    },
    nextAll: function(elem) {
      return jQuery.dir(elem, "nextSibling");
    },
    prevAll: function(elem) {
      return jQuery.dir(elem, "previousSibling");
    },
    nextUntil: function(elem, i, until) {
      return jQuery.dir(elem, "nextSibling", until);
    },
    prevUntil: function(elem, i, until) {
      return jQuery.dir(elem, "previousSibling", until);
    },
    siblings: function(elem) {
      return jQuery.sibling((elem.parentNode || {}).firstChild, elem);
    },
    children: function(elem) {
      return jQuery.sibling(elem.firstChild);
    },
    contents: function(elem) {
      return elem.contentDocument || jQuery.merge([], elem.childNodes);
    }
  }, function(name, fn) {
    jQuery.fn[name] = function(until, selector) {
      var matched = jQuery.map(this, fn, until);
      if (name.slice(-5) !== "Until") {
        selector = until;
      }
      if (selector && typeof selector === "string") {
        matched = jQuery.filter(selector, matched);
      }
      if (this.length > 1) {
        if (!guaranteedUnique[name]) {
          jQuery.unique(matched);
        }
        if (rparentsprev.test(name)) {
          matched.reverse();
        }
      }
      return this.pushStack(matched);
    };
  });
  var rnotwhite = (/\S+/g);
  var optionsCache = {};
  function createOptions(options) {
    var object = optionsCache[options] = {};
    jQuery.each(options.match(rnotwhite) || [], function(_, flag) {
      object[flag] = true;
    });
    return object;
  }
  jQuery.Callbacks = function(options) {
    options = typeof options === "string" ? (optionsCache[options] || createOptions(options)) : jQuery.extend({}, options);
    var memory,
        fired,
        firing,
        firingStart,
        firingLength,
        firingIndex,
        list = [],
        stack = !options.once && [],
        fire = function(data) {
          memory = options.memory && data;
          fired = true;
          firingIndex = firingStart || 0;
          firingStart = 0;
          firingLength = list.length;
          firing = true;
          for (; list && firingIndex < firingLength; firingIndex++) {
            if (list[firingIndex].apply(data[0], data[1]) === false && options.stopOnFalse) {
              memory = false;
              break;
            }
          }
          firing = false;
          if (list) {
            if (stack) {
              if (stack.length) {
                fire(stack.shift());
              }
            } else if (memory) {
              list = [];
            } else {
              self.disable();
            }
          }
        },
        self = {
          add: function() {
            if (list) {
              var start = list.length;
              (function add(args) {
                jQuery.each(args, function(_, arg) {
                  var type = jQuery.type(arg);
                  if (type === "function") {
                    if (!options.unique || !self.has(arg)) {
                      list.push(arg);
                    }
                  } else if (arg && arg.length && type !== "string") {
                    add(arg);
                  }
                });
              })(arguments);
              if (firing) {
                firingLength = list.length;
              } else if (memory) {
                firingStart = start;
                fire(memory);
              }
            }
            return this;
          },
          remove: function() {
            if (list) {
              jQuery.each(arguments, function(_, arg) {
                var index;
                while ((index = jQuery.inArray(arg, list, index)) > -1) {
                  list.splice(index, 1);
                  if (firing) {
                    if (index <= firingLength) {
                      firingLength--;
                    }
                    if (index <= firingIndex) {
                      firingIndex--;
                    }
                  }
                }
              });
            }
            return this;
          },
          has: function(fn) {
            return fn ? jQuery.inArray(fn, list) > -1 : !!(list && list.length);
          },
          empty: function() {
            list = [];
            firingLength = 0;
            return this;
          },
          disable: function() {
            list = stack = memory = undefined;
            return this;
          },
          disabled: function() {
            return !list;
          },
          lock: function() {
            stack = undefined;
            if (!memory) {
              self.disable();
            }
            return this;
          },
          locked: function() {
            return !stack;
          },
          fireWith: function(context, args) {
            if (list && (!fired || stack)) {
              args = args || [];
              args = [context, args.slice ? args.slice() : args];
              if (firing) {
                stack.push(args);
              } else {
                fire(args);
              }
            }
            return this;
          },
          fire: function() {
            self.fireWith(this, arguments);
            return this;
          },
          fired: function() {
            return !!fired;
          }
        };
    return self;
  };
  jQuery.extend({
    Deferred: function(func) {
      var tuples = [["resolve", "done", jQuery.Callbacks("once memory"), "resolved"], ["reject", "fail", jQuery.Callbacks("once memory"), "rejected"], ["notify", "progress", jQuery.Callbacks("memory")]],
          state = "pending",
          promise = {
            state: function() {
              return state;
            },
            always: function() {
              deferred.done(arguments).fail(arguments);
              return this;
            },
            then: function() {
              var fns = arguments;
              return jQuery.Deferred(function(newDefer) {
                jQuery.each(tuples, function(i, tuple) {
                  var fn = jQuery.isFunction(fns[i]) && fns[i];
                  deferred[tuple[1]](function() {
                    var returned = fn && fn.apply(this, arguments);
                    if (returned && jQuery.isFunction(returned.promise)) {
                      returned.promise().done(newDefer.resolve).fail(newDefer.reject).progress(newDefer.notify);
                    } else {
                      newDefer[tuple[0] + "With"](this === promise ? newDefer.promise() : this, fn ? [returned] : arguments);
                    }
                  });
                });
                fns = null;
              }).promise();
            },
            promise: function(obj) {
              return obj != null ? jQuery.extend(obj, promise) : promise;
            }
          },
          deferred = {};
      promise.pipe = promise.then;
      jQuery.each(tuples, function(i, tuple) {
        var list = tuple[2],
            stateString = tuple[3];
        promise[tuple[1]] = list.add;
        if (stateString) {
          list.add(function() {
            state = stateString;
          }, tuples[i ^ 1][2].disable, tuples[2][2].lock);
        }
        deferred[tuple[0]] = function() {
          deferred[tuple[0] + "With"](this === deferred ? promise : this, arguments);
          return this;
        };
        deferred[tuple[0] + "With"] = list.fireWith;
      });
      promise.promise(deferred);
      if (func) {
        func.call(deferred, deferred);
      }
      return deferred;
    },
    when: function(subordinate) {
      var i = 0,
          resolveValues = slice.call(arguments),
          length = resolveValues.length,
          remaining = length !== 1 || (subordinate && jQuery.isFunction(subordinate.promise)) ? length : 0,
          deferred = remaining === 1 ? subordinate : jQuery.Deferred(),
          updateFunc = function(i, contexts, values) {
            return function(value) {
              contexts[i] = this;
              values[i] = arguments.length > 1 ? slice.call(arguments) : value;
              if (values === progressValues) {
                deferred.notifyWith(contexts, values);
              } else if (!(--remaining)) {
                deferred.resolveWith(contexts, values);
              }
            };
          },
          progressValues,
          progressContexts,
          resolveContexts;
      if (length > 1) {
        progressValues = new Array(length);
        progressContexts = new Array(length);
        resolveContexts = new Array(length);
        for (; i < length; i++) {
          if (resolveValues[i] && jQuery.isFunction(resolveValues[i].promise)) {
            resolveValues[i].promise().done(updateFunc(i, resolveContexts, resolveValues)).fail(deferred.reject).progress(updateFunc(i, progressContexts, progressValues));
          } else {
            --remaining;
          }
        }
      }
      if (!remaining) {
        deferred.resolveWith(resolveContexts, resolveValues);
      }
      return deferred.promise();
    }
  });
  var readyList;
  jQuery.fn.ready = function(fn) {
    jQuery.ready.promise().done(fn);
    return this;
  };
  jQuery.extend({
    isReady: false,
    readyWait: 1,
    holdReady: function(hold) {
      if (hold) {
        jQuery.readyWait++;
      } else {
        jQuery.ready(true);
      }
    },
    ready: function(wait) {
      if (wait === true ? --jQuery.readyWait : jQuery.isReady) {
        return ;
      }
      jQuery.isReady = true;
      if (wait !== true && --jQuery.readyWait > 0) {
        return ;
      }
      readyList.resolveWith(document, [jQuery]);
      if (jQuery.fn.triggerHandler) {
        jQuery(document).triggerHandler("ready");
        jQuery(document).off("ready");
      }
    }
  });
  function completed() {
    document.removeEventListener("DOMContentLoaded", completed, false);
    window.removeEventListener("load", completed, false);
    jQuery.ready();
  }
  jQuery.ready.promise = function(obj) {
    if (!readyList) {
      readyList = jQuery.Deferred();
      if (document.readyState === "complete") {
        setTimeout(jQuery.ready);
      } else {
        document.addEventListener("DOMContentLoaded", completed, false);
        window.addEventListener("load", completed, false);
      }
    }
    return readyList.promise(obj);
  };
  jQuery.ready.promise();
  var access = jQuery.access = function(elems, fn, key, value, chainable, emptyGet, raw) {
    var i = 0,
        len = elems.length,
        bulk = key == null;
    if (jQuery.type(key) === "object") {
      chainable = true;
      for (i in key) {
        jQuery.access(elems, fn, i, key[i], true, emptyGet, raw);
      }
    } else if (value !== undefined) {
      chainable = true;
      if (!jQuery.isFunction(value)) {
        raw = true;
      }
      if (bulk) {
        if (raw) {
          fn.call(elems, value);
          fn = null;
        } else {
          bulk = fn;
          fn = function(elem, key, value) {
            return bulk.call(jQuery(elem), value);
          };
        }
      }
      if (fn) {
        for (; i < len; i++) {
          fn(elems[i], key, raw ? value : value.call(elems[i], i, fn(elems[i], key)));
        }
      }
    }
    return chainable ? elems : bulk ? fn.call(elems) : len ? fn(elems[0], key) : emptyGet;
  };
  jQuery.acceptData = function(owner) {
    return owner.nodeType === 1 || owner.nodeType === 9 || !(+owner.nodeType);
  };
  function Data() {
    Object.defineProperty(this.cache = {}, 0, {get: function() {
        return {};
      }});
    this.expando = jQuery.expando + Data.uid++;
  }
  Data.uid = 1;
  Data.accepts = jQuery.acceptData;
  Data.prototype = {
    key: function(owner) {
      if (!Data.accepts(owner)) {
        return 0;
      }
      var descriptor = {},
          unlock = owner[this.expando];
      if (!unlock) {
        unlock = Data.uid++;
        try {
          descriptor[this.expando] = {value: unlock};
          Object.defineProperties(owner, descriptor);
        } catch (e) {
          descriptor[this.expando] = unlock;
          jQuery.extend(owner, descriptor);
        }
      }
      if (!this.cache[unlock]) {
        this.cache[unlock] = {};
      }
      return unlock;
    },
    set: function(owner, data, value) {
      var prop,
          unlock = this.key(owner),
          cache = this.cache[unlock];
      if (typeof data === "string") {
        cache[data] = value;
      } else {
        if (jQuery.isEmptyObject(cache)) {
          jQuery.extend(this.cache[unlock], data);
        } else {
          for (prop in data) {
            cache[prop] = data[prop];
          }
        }
      }
      return cache;
    },
    get: function(owner, key) {
      var cache = this.cache[this.key(owner)];
      return key === undefined ? cache : cache[key];
    },
    access: function(owner, key, value) {
      var stored;
      if (key === undefined || ((key && typeof key === "string") && value === undefined)) {
        stored = this.get(owner, key);
        return stored !== undefined ? stored : this.get(owner, jQuery.camelCase(key));
      }
      this.set(owner, key, value);
      return value !== undefined ? value : key;
    },
    remove: function(owner, key) {
      var i,
          name,
          camel,
          unlock = this.key(owner),
          cache = this.cache[unlock];
      if (key === undefined) {
        this.cache[unlock] = {};
      } else {
        if (jQuery.isArray(key)) {
          name = key.concat(key.map(jQuery.camelCase));
        } else {
          camel = jQuery.camelCase(key);
          if (key in cache) {
            name = [key, camel];
          } else {
            name = camel;
            name = name in cache ? [name] : (name.match(rnotwhite) || []);
          }
        }
        i = name.length;
        while (i--) {
          delete cache[name[i]];
        }
      }
    },
    hasData: function(owner) {
      return !jQuery.isEmptyObject(this.cache[owner[this.expando]] || {});
    },
    discard: function(owner) {
      if (owner[this.expando]) {
        delete this.cache[owner[this.expando]];
      }
    }
  };
  var data_priv = new Data();
  var data_user = new Data();
  var rbrace = /^(?:\{[\w\W]*\}|\[[\w\W]*\])$/,
      rmultiDash = /([A-Z])/g;
  function dataAttr(elem, key, data) {
    var name;
    if (data === undefined && elem.nodeType === 1) {
      name = "data-" + key.replace(rmultiDash, "-$1").toLowerCase();
      data = elem.getAttribute(name);
      if (typeof data === "string") {
        try {
          data = data === "true" ? true : data === "false" ? false : data === "null" ? null : +data + "" === data ? +data : rbrace.test(data) ? jQuery.parseJSON(data) : data;
        } catch (e) {}
        data_user.set(elem, key, data);
      } else {
        data = undefined;
      }
    }
    return data;
  }
  jQuery.extend({
    hasData: function(elem) {
      return data_user.hasData(elem) || data_priv.hasData(elem);
    },
    data: function(elem, name, data) {
      return data_user.access(elem, name, data);
    },
    removeData: function(elem, name) {
      data_user.remove(elem, name);
    },
    _data: function(elem, name, data) {
      return data_priv.access(elem, name, data);
    },
    _removeData: function(elem, name) {
      data_priv.remove(elem, name);
    }
  });
  jQuery.fn.extend({
    data: function(key, value) {
      var i,
          name,
          data,
          elem = this[0],
          attrs = elem && elem.attributes;
      if (key === undefined) {
        if (this.length) {
          data = data_user.get(elem);
          if (elem.nodeType === 1 && !data_priv.get(elem, "hasDataAttrs")) {
            i = attrs.length;
            while (i--) {
              if (attrs[i]) {
                name = attrs[i].name;
                if (name.indexOf("data-") === 0) {
                  name = jQuery.camelCase(name.slice(5));
                  dataAttr(elem, name, data[name]);
                }
              }
            }
            data_priv.set(elem, "hasDataAttrs", true);
          }
        }
        return data;
      }
      if (typeof key === "object") {
        return this.each(function() {
          data_user.set(this, key);
        });
      }
      return access(this, function(value) {
        var data,
            camelKey = jQuery.camelCase(key);
        if (elem && value === undefined) {
          data = data_user.get(elem, key);
          if (data !== undefined) {
            return data;
          }
          data = data_user.get(elem, camelKey);
          if (data !== undefined) {
            return data;
          }
          data = dataAttr(elem, camelKey, undefined);
          if (data !== undefined) {
            return data;
          }
          return ;
        }
        this.each(function() {
          var data = data_user.get(this, camelKey);
          data_user.set(this, camelKey, value);
          if (key.indexOf("-") !== -1 && data !== undefined) {
            data_user.set(this, key, value);
          }
        });
      }, null, value, arguments.length > 1, null, true);
    },
    removeData: function(key) {
      return this.each(function() {
        data_user.remove(this, key);
      });
    }
  });
  jQuery.extend({
    queue: function(elem, type, data) {
      var queue;
      if (elem) {
        type = (type || "fx") + "queue";
        queue = data_priv.get(elem, type);
        if (data) {
          if (!queue || jQuery.isArray(data)) {
            queue = data_priv.access(elem, type, jQuery.makeArray(data));
          } else {
            queue.push(data);
          }
        }
        return queue || [];
      }
    },
    dequeue: function(elem, type) {
      type = type || "fx";
      var queue = jQuery.queue(elem, type),
          startLength = queue.length,
          fn = queue.shift(),
          hooks = jQuery._queueHooks(elem, type),
          next = function() {
            jQuery.dequeue(elem, type);
          };
      if (fn === "inprogress") {
        fn = queue.shift();
        startLength--;
      }
      if (fn) {
        if (type === "fx") {
          queue.unshift("inprogress");
        }
        delete hooks.stop;
        fn.call(elem, next, hooks);
      }
      if (!startLength && hooks) {
        hooks.empty.fire();
      }
    },
    _queueHooks: function(elem, type) {
      var key = type + "queueHooks";
      return data_priv.get(elem, key) || data_priv.access(elem, key, {empty: jQuery.Callbacks("once memory").add(function() {
          data_priv.remove(elem, [type + "queue", key]);
        })});
    }
  });
  jQuery.fn.extend({
    queue: function(type, data) {
      var setter = 2;
      if (typeof type !== "string") {
        data = type;
        type = "fx";
        setter--;
      }
      if (arguments.length < setter) {
        return jQuery.queue(this[0], type);
      }
      return data === undefined ? this : this.each(function() {
        var queue = jQuery.queue(this, type, data);
        jQuery._queueHooks(this, type);
        if (type === "fx" && queue[0] !== "inprogress") {
          jQuery.dequeue(this, type);
        }
      });
    },
    dequeue: function(type) {
      return this.each(function() {
        jQuery.dequeue(this, type);
      });
    },
    clearQueue: function(type) {
      return this.queue(type || "fx", []);
    },
    promise: function(type, obj) {
      var tmp,
          count = 1,
          defer = jQuery.Deferred(),
          elements = this,
          i = this.length,
          resolve = function() {
            if (!(--count)) {
              defer.resolveWith(elements, [elements]);
            }
          };
      if (typeof type !== "string") {
        obj = type;
        type = undefined;
      }
      type = type || "fx";
      while (i--) {
        tmp = data_priv.get(elements[i], type + "queueHooks");
        if (tmp && tmp.empty) {
          count++;
          tmp.empty.add(resolve);
        }
      }
      resolve();
      return defer.promise(obj);
    }
  });
  var pnum = (/[+-]?(?:\d*\.|)\d+(?:[eE][+-]?\d+|)/).source;
  var cssExpand = ["Top", "Right", "Bottom", "Left"];
  var isHidden = function(elem, el) {
    elem = el || elem;
    return jQuery.css(elem, "display") === "none" || !jQuery.contains(elem.ownerDocument, elem);
  };
  var rcheckableType = (/^(?:checkbox|radio)$/i);
  (function() {
    var fragment = document.createDocumentFragment(),
        div = fragment.appendChild(document.createElement("div")),
        input = document.createElement("input");
    input.setAttribute("type", "radio");
    input.setAttribute("checked", "checked");
    input.setAttribute("name", "t");
    div.appendChild(input);
    support.checkClone = div.cloneNode(true).cloneNode(true).lastChild.checked;
    div.innerHTML = "<textarea>x</textarea>";
    support.noCloneChecked = !!div.cloneNode(true).lastChild.defaultValue;
  })();
  var strundefined = typeof undefined;
  support.focusinBubbles = "onfocusin" in window;
  var rkeyEvent = /^key/,
      rmouseEvent = /^(?:mouse|pointer|contextmenu)|click/,
      rfocusMorph = /^(?:focusinfocus|focusoutblur)$/,
      rtypenamespace = /^([^.]*)(?:\.(.+)|)$/;
  function returnTrue() {
    return true;
  }
  function returnFalse() {
    return false;
  }
  function safeActiveElement() {
    try {
      return document.activeElement;
    } catch (err) {}
  }
  jQuery.event = {
    global: {},
    add: function(elem, types, handler, data, selector) {
      var handleObjIn,
          eventHandle,
          tmp,
          events,
          t,
          handleObj,
          special,
          handlers,
          type,
          namespaces,
          origType,
          elemData = data_priv.get(elem);
      if (!elemData) {
        return ;
      }
      if (handler.handler) {
        handleObjIn = handler;
        handler = handleObjIn.handler;
        selector = handleObjIn.selector;
      }
      if (!handler.guid) {
        handler.guid = jQuery.guid++;
      }
      if (!(events = elemData.events)) {
        events = elemData.events = {};
      }
      if (!(eventHandle = elemData.handle)) {
        eventHandle = elemData.handle = function(e) {
          return typeof jQuery !== strundefined && jQuery.event.triggered !== e.type ? jQuery.event.dispatch.apply(elem, arguments) : undefined;
        };
      }
      types = (types || "").match(rnotwhite) || [""];
      t = types.length;
      while (t--) {
        tmp = rtypenamespace.exec(types[t]) || [];
        type = origType = tmp[1];
        namespaces = (tmp[2] || "").split(".").sort();
        if (!type) {
          continue;
        }
        special = jQuery.event.special[type] || {};
        type = (selector ? special.delegateType : special.bindType) || type;
        special = jQuery.event.special[type] || {};
        handleObj = jQuery.extend({
          type: type,
          origType: origType,
          data: data,
          handler: handler,
          guid: handler.guid,
          selector: selector,
          needsContext: selector && jQuery.expr.match.needsContext.test(selector),
          namespace: namespaces.join(".")
        }, handleObjIn);
        if (!(handlers = events[type])) {
          handlers = events[type] = [];
          handlers.delegateCount = 0;
          if (!special.setup || special.setup.call(elem, data, namespaces, eventHandle) === false) {
            if (elem.addEventListener) {
              elem.addEventListener(type, eventHandle, false);
            }
          }
        }
        if (special.add) {
          special.add.call(elem, handleObj);
          if (!handleObj.handler.guid) {
            handleObj.handler.guid = handler.guid;
          }
        }
        if (selector) {
          handlers.splice(handlers.delegateCount++, 0, handleObj);
        } else {
          handlers.push(handleObj);
        }
        jQuery.event.global[type] = true;
      }
    },
    remove: function(elem, types, handler, selector, mappedTypes) {
      var j,
          origCount,
          tmp,
          events,
          t,
          handleObj,
          special,
          handlers,
          type,
          namespaces,
          origType,
          elemData = data_priv.hasData(elem) && data_priv.get(elem);
      if (!elemData || !(events = elemData.events)) {
        return ;
      }
      types = (types || "").match(rnotwhite) || [""];
      t = types.length;
      while (t--) {
        tmp = rtypenamespace.exec(types[t]) || [];
        type = origType = tmp[1];
        namespaces = (tmp[2] || "").split(".").sort();
        if (!type) {
          for (type in events) {
            jQuery.event.remove(elem, type + types[t], handler, selector, true);
          }
          continue;
        }
        special = jQuery.event.special[type] || {};
        type = (selector ? special.delegateType : special.bindType) || type;
        handlers = events[type] || [];
        tmp = tmp[2] && new RegExp("(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)");
        origCount = j = handlers.length;
        while (j--) {
          handleObj = handlers[j];
          if ((mappedTypes || origType === handleObj.origType) && (!handler || handler.guid === handleObj.guid) && (!tmp || tmp.test(handleObj.namespace)) && (!selector || selector === handleObj.selector || selector === "**" && handleObj.selector)) {
            handlers.splice(j, 1);
            if (handleObj.selector) {
              handlers.delegateCount--;
            }
            if (special.remove) {
              special.remove.call(elem, handleObj);
            }
          }
        }
        if (origCount && !handlers.length) {
          if (!special.teardown || special.teardown.call(elem, namespaces, elemData.handle) === false) {
            jQuery.removeEvent(elem, type, elemData.handle);
          }
          delete events[type];
        }
      }
      if (jQuery.isEmptyObject(events)) {
        delete elemData.handle;
        data_priv.remove(elem, "events");
      }
    },
    trigger: function(event, data, elem, onlyHandlers) {
      var i,
          cur,
          tmp,
          bubbleType,
          ontype,
          handle,
          special,
          eventPath = [elem || document],
          type = hasOwn.call(event, "type") ? event.type : event,
          namespaces = hasOwn.call(event, "namespace") ? event.namespace.split(".") : [];
      cur = tmp = elem = elem || document;
      if (elem.nodeType === 3 || elem.nodeType === 8) {
        return ;
      }
      if (rfocusMorph.test(type + jQuery.event.triggered)) {
        return ;
      }
      if (type.indexOf(".") >= 0) {
        namespaces = type.split(".");
        type = namespaces.shift();
        namespaces.sort();
      }
      ontype = type.indexOf(":") < 0 && "on" + type;
      event = event[jQuery.expando] ? event : new jQuery.Event(type, typeof event === "object" && event);
      event.isTrigger = onlyHandlers ? 2 : 3;
      event.namespace = namespaces.join(".");
      event.namespace_re = event.namespace ? new RegExp("(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)") : null;
      event.result = undefined;
      if (!event.target) {
        event.target = elem;
      }
      data = data == null ? [event] : jQuery.makeArray(data, [event]);
      special = jQuery.event.special[type] || {};
      if (!onlyHandlers && special.trigger && special.trigger.apply(elem, data) === false) {
        return ;
      }
      if (!onlyHandlers && !special.noBubble && !jQuery.isWindow(elem)) {
        bubbleType = special.delegateType || type;
        if (!rfocusMorph.test(bubbleType + type)) {
          cur = cur.parentNode;
        }
        for (; cur; cur = cur.parentNode) {
          eventPath.push(cur);
          tmp = cur;
        }
        if (tmp === (elem.ownerDocument || document)) {
          eventPath.push(tmp.defaultView || tmp.parentWindow || window);
        }
      }
      i = 0;
      while ((cur = eventPath[i++]) && !event.isPropagationStopped()) {
        event.type = i > 1 ? bubbleType : special.bindType || type;
        handle = (data_priv.get(cur, "events") || {})[event.type] && data_priv.get(cur, "handle");
        if (handle) {
          handle.apply(cur, data);
        }
        handle = ontype && cur[ontype];
        if (handle && handle.apply && jQuery.acceptData(cur)) {
          event.result = handle.apply(cur, data);
          if (event.result === false) {
            event.preventDefault();
          }
        }
      }
      event.type = type;
      if (!onlyHandlers && !event.isDefaultPrevented()) {
        if ((!special._default || special._default.apply(eventPath.pop(), data) === false) && jQuery.acceptData(elem)) {
          if (ontype && jQuery.isFunction(elem[type]) && !jQuery.isWindow(elem)) {
            tmp = elem[ontype];
            if (tmp) {
              elem[ontype] = null;
            }
            jQuery.event.triggered = type;
            elem[type]();
            jQuery.event.triggered = undefined;
            if (tmp) {
              elem[ontype] = tmp;
            }
          }
        }
      }
      return event.result;
    },
    dispatch: function(event) {
      event = jQuery.event.fix(event);
      var i,
          j,
          ret,
          matched,
          handleObj,
          handlerQueue = [],
          args = slice.call(arguments),
          handlers = (data_priv.get(this, "events") || {})[event.type] || [],
          special = jQuery.event.special[event.type] || {};
      args[0] = event;
      event.delegateTarget = this;
      if (special.preDispatch && special.preDispatch.call(this, event) === false) {
        return ;
      }
      handlerQueue = jQuery.event.handlers.call(this, event, handlers);
      i = 0;
      while ((matched = handlerQueue[i++]) && !event.isPropagationStopped()) {
        event.currentTarget = matched.elem;
        j = 0;
        while ((handleObj = matched.handlers[j++]) && !event.isImmediatePropagationStopped()) {
          if (!event.namespace_re || event.namespace_re.test(handleObj.namespace)) {
            event.handleObj = handleObj;
            event.data = handleObj.data;
            ret = ((jQuery.event.special[handleObj.origType] || {}).handle || handleObj.handler).apply(matched.elem, args);
            if (ret !== undefined) {
              if ((event.result = ret) === false) {
                event.preventDefault();
                event.stopPropagation();
              }
            }
          }
        }
      }
      if (special.postDispatch) {
        special.postDispatch.call(this, event);
      }
      return event.result;
    },
    handlers: function(event, handlers) {
      var i,
          matches,
          sel,
          handleObj,
          handlerQueue = [],
          delegateCount = handlers.delegateCount,
          cur = event.target;
      if (delegateCount && cur.nodeType && (!event.button || event.type !== "click")) {
        for (; cur !== this; cur = cur.parentNode || this) {
          if (cur.disabled !== true || event.type !== "click") {
            matches = [];
            for (i = 0; i < delegateCount; i++) {
              handleObj = handlers[i];
              sel = handleObj.selector + " ";
              if (matches[sel] === undefined) {
                matches[sel] = handleObj.needsContext ? jQuery(sel, this).index(cur) >= 0 : jQuery.find(sel, this, null, [cur]).length;
              }
              if (matches[sel]) {
                matches.push(handleObj);
              }
            }
            if (matches.length) {
              handlerQueue.push({
                elem: cur,
                handlers: matches
              });
            }
          }
        }
      }
      if (delegateCount < handlers.length) {
        handlerQueue.push({
          elem: this,
          handlers: handlers.slice(delegateCount)
        });
      }
      return handlerQueue;
    },
    props: "altKey bubbles cancelable ctrlKey currentTarget eventPhase metaKey relatedTarget shiftKey target timeStamp view which".split(" "),
    fixHooks: {},
    keyHooks: {
      props: "char charCode key keyCode".split(" "),
      filter: function(event, original) {
        if (event.which == null) {
          event.which = original.charCode != null ? original.charCode : original.keyCode;
        }
        return event;
      }
    },
    mouseHooks: {
      props: "button buttons clientX clientY offsetX offsetY pageX pageY screenX screenY toElement".split(" "),
      filter: function(event, original) {
        var eventDoc,
            doc,
            body,
            button = original.button;
        if (event.pageX == null && original.clientX != null) {
          eventDoc = event.target.ownerDocument || document;
          doc = eventDoc.documentElement;
          body = eventDoc.body;
          event.pageX = original.clientX + (doc && doc.scrollLeft || body && body.scrollLeft || 0) - (doc && doc.clientLeft || body && body.clientLeft || 0);
          event.pageY = original.clientY + (doc && doc.scrollTop || body && body.scrollTop || 0) - (doc && doc.clientTop || body && body.clientTop || 0);
        }
        if (!event.which && button !== undefined) {
          event.which = (button & 1 ? 1 : (button & 2 ? 3 : (button & 4 ? 2 : 0)));
        }
        return event;
      }
    },
    fix: function(event) {
      if (event[jQuery.expando]) {
        return event;
      }
      var i,
          prop,
          copy,
          type = event.type,
          originalEvent = event,
          fixHook = this.fixHooks[type];
      if (!fixHook) {
        this.fixHooks[type] = fixHook = rmouseEvent.test(type) ? this.mouseHooks : rkeyEvent.test(type) ? this.keyHooks : {};
      }
      copy = fixHook.props ? this.props.concat(fixHook.props) : this.props;
      event = new jQuery.Event(originalEvent);
      i = copy.length;
      while (i--) {
        prop = copy[i];
        event[prop] = originalEvent[prop];
      }
      if (!event.target) {
        event.target = document;
      }
      if (event.target.nodeType === 3) {
        event.target = event.target.parentNode;
      }
      return fixHook.filter ? fixHook.filter(event, originalEvent) : event;
    },
    special: {
      load: {noBubble: true},
      focus: {
        trigger: function() {
          if (this !== safeActiveElement() && this.focus) {
            this.focus();
            return false;
          }
        },
        delegateType: "focusin"
      },
      blur: {
        trigger: function() {
          if (this === safeActiveElement() && this.blur) {
            this.blur();
            return false;
          }
        },
        delegateType: "focusout"
      },
      click: {
        trigger: function() {
          if (this.type === "checkbox" && this.click && jQuery.nodeName(this, "input")) {
            this.click();
            return false;
          }
        },
        _default: function(event) {
          return jQuery.nodeName(event.target, "a");
        }
      },
      beforeunload: {postDispatch: function(event) {
          if (event.result !== undefined && event.originalEvent) {
            event.originalEvent.returnValue = event.result;
          }
        }}
    },
    simulate: function(type, elem, event, bubble) {
      var e = jQuery.extend(new jQuery.Event(), event, {
        type: type,
        isSimulated: true,
        originalEvent: {}
      });
      if (bubble) {
        jQuery.event.trigger(e, null, elem);
      } else {
        jQuery.event.dispatch.call(elem, e);
      }
      if (e.isDefaultPrevented()) {
        event.preventDefault();
      }
    }
  };
  jQuery.removeEvent = function(elem, type, handle) {
    if (elem.removeEventListener) {
      elem.removeEventListener(type, handle, false);
    }
  };
  jQuery.Event = function(src, props) {
    if (!(this instanceof jQuery.Event)) {
      return new jQuery.Event(src, props);
    }
    if (src && src.type) {
      this.originalEvent = src;
      this.type = src.type;
      this.isDefaultPrevented = src.defaultPrevented || src.defaultPrevented === undefined && src.returnValue === false ? returnTrue : returnFalse;
    } else {
      this.type = src;
    }
    if (props) {
      jQuery.extend(this, props);
    }
    this.timeStamp = src && src.timeStamp || jQuery.now();
    this[jQuery.expando] = true;
  };
  jQuery.Event.prototype = {
    isDefaultPrevented: returnFalse,
    isPropagationStopped: returnFalse,
    isImmediatePropagationStopped: returnFalse,
    preventDefault: function() {
      var e = this.originalEvent;
      this.isDefaultPrevented = returnTrue;
      if (e && e.preventDefault) {
        e.preventDefault();
      }
    },
    stopPropagation: function() {
      var e = this.originalEvent;
      this.isPropagationStopped = returnTrue;
      if (e && e.stopPropagation) {
        e.stopPropagation();
      }
    },
    stopImmediatePropagation: function() {
      var e = this.originalEvent;
      this.isImmediatePropagationStopped = returnTrue;
      if (e && e.stopImmediatePropagation) {
        e.stopImmediatePropagation();
      }
      this.stopPropagation();
    }
  };
  jQuery.each({
    mouseenter: "mouseover",
    mouseleave: "mouseout",
    pointerenter: "pointerover",
    pointerleave: "pointerout"
  }, function(orig, fix) {
    jQuery.event.special[orig] = {
      delegateType: fix,
      bindType: fix,
      handle: function(event) {
        var ret,
            target = this,
            related = event.relatedTarget,
            handleObj = event.handleObj;
        if (!related || (related !== target && !jQuery.contains(target, related))) {
          event.type = handleObj.origType;
          ret = handleObj.handler.apply(this, arguments);
          event.type = fix;
        }
        return ret;
      }
    };
  });
  if (!support.focusinBubbles) {
    jQuery.each({
      focus: "focusin",
      blur: "focusout"
    }, function(orig, fix) {
      var handler = function(event) {
        jQuery.event.simulate(fix, event.target, jQuery.event.fix(event), true);
      };
      jQuery.event.special[fix] = {
        setup: function() {
          var doc = this.ownerDocument || this,
              attaches = data_priv.access(doc, fix);
          if (!attaches) {
            doc.addEventListener(orig, handler, true);
          }
          data_priv.access(doc, fix, (attaches || 0) + 1);
        },
        teardown: function() {
          var doc = this.ownerDocument || this,
              attaches = data_priv.access(doc, fix) - 1;
          if (!attaches) {
            doc.removeEventListener(orig, handler, true);
            data_priv.remove(doc, fix);
          } else {
            data_priv.access(doc, fix, attaches);
          }
        }
      };
    });
  }
  jQuery.fn.extend({
    on: function(types, selector, data, fn, one) {
      var origFn,
          type;
      if (typeof types === "object") {
        if (typeof selector !== "string") {
          data = data || selector;
          selector = undefined;
        }
        for (type in types) {
          this.on(type, selector, data, types[type], one);
        }
        return this;
      }
      if (data == null && fn == null) {
        fn = selector;
        data = selector = undefined;
      } else if (fn == null) {
        if (typeof selector === "string") {
          fn = data;
          data = undefined;
        } else {
          fn = data;
          data = selector;
          selector = undefined;
        }
      }
      if (fn === false) {
        fn = returnFalse;
      } else if (!fn) {
        return this;
      }
      if (one === 1) {
        origFn = fn;
        fn = function(event) {
          jQuery().off(event);
          return origFn.apply(this, arguments);
        };
        fn.guid = origFn.guid || (origFn.guid = jQuery.guid++);
      }
      return this.each(function() {
        jQuery.event.add(this, types, fn, data, selector);
      });
    },
    one: function(types, selector, data, fn) {
      return this.on(types, selector, data, fn, 1);
    },
    off: function(types, selector, fn) {
      var handleObj,
          type;
      if (types && types.preventDefault && types.handleObj) {
        handleObj = types.handleObj;
        jQuery(types.delegateTarget).off(handleObj.namespace ? handleObj.origType + "." + handleObj.namespace : handleObj.origType, handleObj.selector, handleObj.handler);
        return this;
      }
      if (typeof types === "object") {
        for (type in types) {
          this.off(type, selector, types[type]);
        }
        return this;
      }
      if (selector === false || typeof selector === "function") {
        fn = selector;
        selector = undefined;
      }
      if (fn === false) {
        fn = returnFalse;
      }
      return this.each(function() {
        jQuery.event.remove(this, types, fn, selector);
      });
    },
    trigger: function(type, data) {
      return this.each(function() {
        jQuery.event.trigger(type, data, this);
      });
    },
    triggerHandler: function(type, data) {
      var elem = this[0];
      if (elem) {
        return jQuery.event.trigger(type, data, elem, true);
      }
    }
  });
  var rxhtmlTag = /<(?!area|br|col|embed|hr|img|input|link|meta|param)(([\w:]+)[^>]*)\/>/gi,
      rtagName = /<([\w:]+)/,
      rhtml = /<|&#?\w+;/,
      rnoInnerhtml = /<(?:script|style|link)/i,
      rchecked = /checked\s*(?:[^=]|=\s*.checked.)/i,
      rscriptType = /^$|\/(?:java|ecma)script/i,
      rscriptTypeMasked = /^true\/(.*)/,
      rcleanScript = /^\s*<!(?:\[CDATA\[|--)|(?:\]\]|--)>\s*$/g,
      wrapMap = {
        option: [1, "<select multiple='multiple'>", "</select>"],
        thead: [1, "<table>", "</table>"],
        col: [2, "<table><colgroup>", "</colgroup></table>"],
        tr: [2, "<table><tbody>", "</tbody></table>"],
        td: [3, "<table><tbody><tr>", "</tr></tbody></table>"],
        _default: [0, "", ""]
      };
  wrapMap.optgroup = wrapMap.option;
  wrapMap.tbody = wrapMap.tfoot = wrapMap.colgroup = wrapMap.caption = wrapMap.thead;
  wrapMap.th = wrapMap.td;
  function manipulationTarget(elem, content) {
    return jQuery.nodeName(elem, "table") && jQuery.nodeName(content.nodeType !== 11 ? content : content.firstChild, "tr") ? elem.getElementsByTagName("tbody")[0] || elem.appendChild(elem.ownerDocument.createElement("tbody")) : elem;
  }
  function disableScript(elem) {
    elem.type = (elem.getAttribute("type") !== null) + "/" + elem.type;
    return elem;
  }
  function restoreScript(elem) {
    var match = rscriptTypeMasked.exec(elem.type);
    if (match) {
      elem.type = match[1];
    } else {
      elem.removeAttribute("type");
    }
    return elem;
  }
  function setGlobalEval(elems, refElements) {
    var i = 0,
        l = elems.length;
    for (; i < l; i++) {
      data_priv.set(elems[i], "globalEval", !refElements || data_priv.get(refElements[i], "globalEval"));
    }
  }
  function cloneCopyEvent(src, dest) {
    var i,
        l,
        type,
        pdataOld,
        pdataCur,
        udataOld,
        udataCur,
        events;
    if (dest.nodeType !== 1) {
      return ;
    }
    if (data_priv.hasData(src)) {
      pdataOld = data_priv.access(src);
      pdataCur = data_priv.set(dest, pdataOld);
      events = pdataOld.events;
      if (events) {
        delete pdataCur.handle;
        pdataCur.events = {};
        for (type in events) {
          for (i = 0, l = events[type].length; i < l; i++) {
            jQuery.event.add(dest, type, events[type][i]);
          }
        }
      }
    }
    if (data_user.hasData(src)) {
      udataOld = data_user.access(src);
      udataCur = jQuery.extend({}, udataOld);
      data_user.set(dest, udataCur);
    }
  }
  function getAll(context, tag) {
    var ret = context.getElementsByTagName ? context.getElementsByTagName(tag || "*") : context.querySelectorAll ? context.querySelectorAll(tag || "*") : [];
    return tag === undefined || tag && jQuery.nodeName(context, tag) ? jQuery.merge([context], ret) : ret;
  }
  function fixInput(src, dest) {
    var nodeName = dest.nodeName.toLowerCase();
    if (nodeName === "input" && rcheckableType.test(src.type)) {
      dest.checked = src.checked;
    } else if (nodeName === "input" || nodeName === "textarea") {
      dest.defaultValue = src.defaultValue;
    }
  }
  jQuery.extend({
    clone: function(elem, dataAndEvents, deepDataAndEvents) {
      var i,
          l,
          srcElements,
          destElements,
          clone = elem.cloneNode(true),
          inPage = jQuery.contains(elem.ownerDocument, elem);
      if (!support.noCloneChecked && (elem.nodeType === 1 || elem.nodeType === 11) && !jQuery.isXMLDoc(elem)) {
        destElements = getAll(clone);
        srcElements = getAll(elem);
        for (i = 0, l = srcElements.length; i < l; i++) {
          fixInput(srcElements[i], destElements[i]);
        }
      }
      if (dataAndEvents) {
        if (deepDataAndEvents) {
          srcElements = srcElements || getAll(elem);
          destElements = destElements || getAll(clone);
          for (i = 0, l = srcElements.length; i < l; i++) {
            cloneCopyEvent(srcElements[i], destElements[i]);
          }
        } else {
          cloneCopyEvent(elem, clone);
        }
      }
      destElements = getAll(clone, "script");
      if (destElements.length > 0) {
        setGlobalEval(destElements, !inPage && getAll(elem, "script"));
      }
      return clone;
    },
    buildFragment: function(elems, context, scripts, selection) {
      var elem,
          tmp,
          tag,
          wrap,
          contains,
          j,
          fragment = context.createDocumentFragment(),
          nodes = [],
          i = 0,
          l = elems.length;
      for (; i < l; i++) {
        elem = elems[i];
        if (elem || elem === 0) {
          if (jQuery.type(elem) === "object") {
            jQuery.merge(nodes, elem.nodeType ? [elem] : elem);
          } else if (!rhtml.test(elem)) {
            nodes.push(context.createTextNode(elem));
          } else {
            tmp = tmp || fragment.appendChild(context.createElement("div"));
            tag = (rtagName.exec(elem) || ["", ""])[1].toLowerCase();
            wrap = wrapMap[tag] || wrapMap._default;
            tmp.innerHTML = wrap[1] + elem.replace(rxhtmlTag, "<$1></$2>") + wrap[2];
            j = wrap[0];
            while (j--) {
              tmp = tmp.lastChild;
            }
            jQuery.merge(nodes, tmp.childNodes);
            tmp = fragment.firstChild;
            tmp.textContent = "";
          }
        }
      }
      fragment.textContent = "";
      i = 0;
      while ((elem = nodes[i++])) {
        if (selection && jQuery.inArray(elem, selection) !== -1) {
          continue;
        }
        contains = jQuery.contains(elem.ownerDocument, elem);
        tmp = getAll(fragment.appendChild(elem), "script");
        if (contains) {
          setGlobalEval(tmp);
        }
        if (scripts) {
          j = 0;
          while ((elem = tmp[j++])) {
            if (rscriptType.test(elem.type || "")) {
              scripts.push(elem);
            }
          }
        }
      }
      return fragment;
    },
    cleanData: function(elems) {
      var data,
          elem,
          type,
          key,
          special = jQuery.event.special,
          i = 0;
      for (; (elem = elems[i]) !== undefined; i++) {
        if (jQuery.acceptData(elem)) {
          key = elem[data_priv.expando];
          if (key && (data = data_priv.cache[key])) {
            if (data.events) {
              for (type in data.events) {
                if (special[type]) {
                  jQuery.event.remove(elem, type);
                } else {
                  jQuery.removeEvent(elem, type, data.handle);
                }
              }
            }
            if (data_priv.cache[key]) {
              delete data_priv.cache[key];
            }
          }
        }
        delete data_user.cache[elem[data_user.expando]];
      }
    }
  });
  jQuery.fn.extend({
    text: function(value) {
      return access(this, function(value) {
        return value === undefined ? jQuery.text(this) : this.empty().each(function() {
          if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
            this.textContent = value;
          }
        });
      }, null, value, arguments.length);
    },
    append: function() {
      return this.domManip(arguments, function(elem) {
        if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
          var target = manipulationTarget(this, elem);
          target.appendChild(elem);
        }
      });
    },
    prepend: function() {
      return this.domManip(arguments, function(elem) {
        if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
          var target = manipulationTarget(this, elem);
          target.insertBefore(elem, target.firstChild);
        }
      });
    },
    before: function() {
      return this.domManip(arguments, function(elem) {
        if (this.parentNode) {
          this.parentNode.insertBefore(elem, this);
        }
      });
    },
    after: function() {
      return this.domManip(arguments, function(elem) {
        if (this.parentNode) {
          this.parentNode.insertBefore(elem, this.nextSibling);
        }
      });
    },
    remove: function(selector, keepData) {
      var elem,
          elems = selector ? jQuery.filter(selector, this) : this,
          i = 0;
      for (; (elem = elems[i]) != null; i++) {
        if (!keepData && elem.nodeType === 1) {
          jQuery.cleanData(getAll(elem));
        }
        if (elem.parentNode) {
          if (keepData && jQuery.contains(elem.ownerDocument, elem)) {
            setGlobalEval(getAll(elem, "script"));
          }
          elem.parentNode.removeChild(elem);
        }
      }
      return this;
    },
    empty: function() {
      var elem,
          i = 0;
      for (; (elem = this[i]) != null; i++) {
        if (elem.nodeType === 1) {
          jQuery.cleanData(getAll(elem, false));
          elem.textContent = "";
        }
      }
      return this;
    },
    clone: function(dataAndEvents, deepDataAndEvents) {
      dataAndEvents = dataAndEvents == null ? false : dataAndEvents;
      deepDataAndEvents = deepDataAndEvents == null ? dataAndEvents : deepDataAndEvents;
      return this.map(function() {
        return jQuery.clone(this, dataAndEvents, deepDataAndEvents);
      });
    },
    html: function(value) {
      return access(this, function(value) {
        var elem = this[0] || {},
            i = 0,
            l = this.length;
        if (value === undefined && elem.nodeType === 1) {
          return elem.innerHTML;
        }
        if (typeof value === "string" && !rnoInnerhtml.test(value) && !wrapMap[(rtagName.exec(value) || ["", ""])[1].toLowerCase()]) {
          value = value.replace(rxhtmlTag, "<$1></$2>");
          try {
            for (; i < l; i++) {
              elem = this[i] || {};
              if (elem.nodeType === 1) {
                jQuery.cleanData(getAll(elem, false));
                elem.innerHTML = value;
              }
            }
            elem = 0;
          } catch (e) {}
        }
        if (elem) {
          this.empty().append(value);
        }
      }, null, value, arguments.length);
    },
    replaceWith: function() {
      var arg = arguments[0];
      this.domManip(arguments, function(elem) {
        arg = this.parentNode;
        jQuery.cleanData(getAll(this));
        if (arg) {
          arg.replaceChild(elem, this);
        }
      });
      return arg && (arg.length || arg.nodeType) ? this : this.remove();
    },
    detach: function(selector) {
      return this.remove(selector, true);
    },
    domManip: function(args, callback) {
      args = concat.apply([], args);
      var fragment,
          first,
          scripts,
          hasScripts,
          node,
          doc,
          i = 0,
          l = this.length,
          set = this,
          iNoClone = l - 1,
          value = args[0],
          isFunction = jQuery.isFunction(value);
      if (isFunction || (l > 1 && typeof value === "string" && !support.checkClone && rchecked.test(value))) {
        return this.each(function(index) {
          var self = set.eq(index);
          if (isFunction) {
            args[0] = value.call(this, index, self.html());
          }
          self.domManip(args, callback);
        });
      }
      if (l) {
        fragment = jQuery.buildFragment(args, this[0].ownerDocument, false, this);
        first = fragment.firstChild;
        if (fragment.childNodes.length === 1) {
          fragment = first;
        }
        if (first) {
          scripts = jQuery.map(getAll(fragment, "script"), disableScript);
          hasScripts = scripts.length;
          for (; i < l; i++) {
            node = fragment;
            if (i !== iNoClone) {
              node = jQuery.clone(node, true, true);
              if (hasScripts) {
                jQuery.merge(scripts, getAll(node, "script"));
              }
            }
            callback.call(this[i], node, i);
          }
          if (hasScripts) {
            doc = scripts[scripts.length - 1].ownerDocument;
            jQuery.map(scripts, restoreScript);
            for (i = 0; i < hasScripts; i++) {
              node = scripts[i];
              if (rscriptType.test(node.type || "") && !data_priv.access(node, "globalEval") && jQuery.contains(doc, node)) {
                if (node.src) {
                  if (jQuery._evalUrl) {
                    jQuery._evalUrl(node.src);
                  }
                } else {
                  jQuery.globalEval(node.textContent.replace(rcleanScript, ""));
                }
              }
            }
          }
        }
      }
      return this;
    }
  });
  jQuery.each({
    appendTo: "append",
    prependTo: "prepend",
    insertBefore: "before",
    insertAfter: "after",
    replaceAll: "replaceWith"
  }, function(name, original) {
    jQuery.fn[name] = function(selector) {
      var elems,
          ret = [],
          insert = jQuery(selector),
          last = insert.length - 1,
          i = 0;
      for (; i <= last; i++) {
        elems = i === last ? this : this.clone(true);
        jQuery(insert[i])[original](elems);
        push.apply(ret, elems.get());
      }
      return this.pushStack(ret);
    };
  });
  var iframe,
      elemdisplay = {};
  function actualDisplay(name, doc) {
    var style,
        elem = jQuery(doc.createElement(name)).appendTo(doc.body),
        display = window.getDefaultComputedStyle && (style = window.getDefaultComputedStyle(elem[0])) ? style.display : jQuery.css(elem[0], "display");
    elem.detach();
    return display;
  }
  function defaultDisplay(nodeName) {
    var doc = document,
        display = elemdisplay[nodeName];
    if (!display) {
      display = actualDisplay(nodeName, doc);
      if (display === "none" || !display) {
        iframe = (iframe || jQuery("<iframe frameborder='0' width='0' height='0'/>")).appendTo(doc.documentElement);
        doc = iframe[0].contentDocument;
        doc.write();
        doc.close();
        display = actualDisplay(nodeName, doc);
        iframe.detach();
      }
      elemdisplay[nodeName] = display;
    }
    return display;
  }
  var rmargin = (/^margin/);
  var rnumnonpx = new RegExp("^(" + pnum + ")(?!px)[a-z%]+$", "i");
  var getStyles = function(elem) {
    if (elem.ownerDocument.defaultView.opener) {
      return elem.ownerDocument.defaultView.getComputedStyle(elem, null);
    }
    return window.getComputedStyle(elem, null);
  };
  function curCSS(elem, name, computed) {
    var width,
        minWidth,
        maxWidth,
        ret,
        style = elem.style;
    computed = computed || getStyles(elem);
    if (computed) {
      ret = computed.getPropertyValue(name) || computed[name];
    }
    if (computed) {
      if (ret === "" && !jQuery.contains(elem.ownerDocument, elem)) {
        ret = jQuery.style(elem, name);
      }
      if (rnumnonpx.test(ret) && rmargin.test(name)) {
        width = style.width;
        minWidth = style.minWidth;
        maxWidth = style.maxWidth;
        style.minWidth = style.maxWidth = style.width = ret;
        ret = computed.width;
        style.width = width;
        style.minWidth = minWidth;
        style.maxWidth = maxWidth;
      }
    }
    return ret !== undefined ? ret + "" : ret;
  }
  function addGetHookIf(conditionFn, hookFn) {
    return {get: function() {
        if (conditionFn()) {
          delete this.get;
          return ;
        }
        return (this.get = hookFn).apply(this, arguments);
      }};
  }
  (function() {
    var pixelPositionVal,
        boxSizingReliableVal,
        docElem = document.documentElement,
        container = document.createElement("div"),
        div = document.createElement("div");
    if (!div.style) {
      return ;
    }
    div.style.backgroundClip = "content-box";
    div.cloneNode(true).style.backgroundClip = "";
    support.clearCloneStyle = div.style.backgroundClip === "content-box";
    container.style.cssText = "border:0;width:0;height:0;top:0;left:-9999px;margin-top:1px;" + "position:absolute";
    container.appendChild(div);
    function computePixelPositionAndBoxSizingReliable() {
      div.style.cssText = "-webkit-box-sizing:border-box;-moz-box-sizing:border-box;" + "box-sizing:border-box;display:block;margin-top:1%;top:1%;" + "border:1px;padding:1px;width:4px;position:absolute";
      div.innerHTML = "";
      docElem.appendChild(container);
      var divStyle = window.getComputedStyle(div, null);
      pixelPositionVal = divStyle.top !== "1%";
      boxSizingReliableVal = divStyle.width === "4px";
      docElem.removeChild(container);
    }
    if (window.getComputedStyle) {
      jQuery.extend(support, {
        pixelPosition: function() {
          computePixelPositionAndBoxSizingReliable();
          return pixelPositionVal;
        },
        boxSizingReliable: function() {
          if (boxSizingReliableVal == null) {
            computePixelPositionAndBoxSizingReliable();
          }
          return boxSizingReliableVal;
        },
        reliableMarginRight: function() {
          var ret,
              marginDiv = div.appendChild(document.createElement("div"));
          marginDiv.style.cssText = div.style.cssText = "-webkit-box-sizing:content-box;-moz-box-sizing:content-box;" + "box-sizing:content-box;display:block;margin:0;border:0;padding:0";
          marginDiv.style.marginRight = marginDiv.style.width = "0";
          div.style.width = "1px";
          docElem.appendChild(container);
          ret = !parseFloat(window.getComputedStyle(marginDiv, null).marginRight);
          docElem.removeChild(container);
          div.removeChild(marginDiv);
          return ret;
        }
      });
    }
  })();
  jQuery.swap = function(elem, options, callback, args) {
    var ret,
        name,
        old = {};
    for (name in options) {
      old[name] = elem.style[name];
      elem.style[name] = options[name];
    }
    ret = callback.apply(elem, args || []);
    for (name in options) {
      elem.style[name] = old[name];
    }
    return ret;
  };
  var rdisplayswap = /^(none|table(?!-c[ea]).+)/,
      rnumsplit = new RegExp("^(" + pnum + ")(.*)$", "i"),
      rrelNum = new RegExp("^([+-])=(" + pnum + ")", "i"),
      cssShow = {
        position: "absolute",
        visibility: "hidden",
        display: "block"
      },
      cssNormalTransform = {
        letterSpacing: "0",
        fontWeight: "400"
      },
      cssPrefixes = ["Webkit", "O", "Moz", "ms"];
  function vendorPropName(style, name) {
    if (name in style) {
      return name;
    }
    var capName = name[0].toUpperCase() + name.slice(1),
        origName = name,
        i = cssPrefixes.length;
    while (i--) {
      name = cssPrefixes[i] + capName;
      if (name in style) {
        return name;
      }
    }
    return origName;
  }
  function setPositiveNumber(elem, value, subtract) {
    var matches = rnumsplit.exec(value);
    return matches ? Math.max(0, matches[1] - (subtract || 0)) + (matches[2] || "px") : value;
  }
  function augmentWidthOrHeight(elem, name, extra, isBorderBox, styles) {
    var i = extra === (isBorderBox ? "border" : "content") ? 4 : name === "width" ? 1 : 0,
        val = 0;
    for (; i < 4; i += 2) {
      if (extra === "margin") {
        val += jQuery.css(elem, extra + cssExpand[i], true, styles);
      }
      if (isBorderBox) {
        if (extra === "content") {
          val -= jQuery.css(elem, "padding" + cssExpand[i], true, styles);
        }
        if (extra !== "margin") {
          val -= jQuery.css(elem, "border" + cssExpand[i] + "Width", true, styles);
        }
      } else {
        val += jQuery.css(elem, "padding" + cssExpand[i], true, styles);
        if (extra !== "padding") {
          val += jQuery.css(elem, "border" + cssExpand[i] + "Width", true, styles);
        }
      }
    }
    return val;
  }
  function getWidthOrHeight(elem, name, extra) {
    var valueIsBorderBox = true,
        val = name === "width" ? elem.offsetWidth : elem.offsetHeight,
        styles = getStyles(elem),
        isBorderBox = jQuery.css(elem, "boxSizing", false, styles) === "border-box";
    if (val <= 0 || val == null) {
      val = curCSS(elem, name, styles);
      if (val < 0 || val == null) {
        val = elem.style[name];
      }
      if (rnumnonpx.test(val)) {
        return val;
      }
      valueIsBorderBox = isBorderBox && (support.boxSizingReliable() || val === elem.style[name]);
      val = parseFloat(val) || 0;
    }
    return (val + augmentWidthOrHeight(elem, name, extra || (isBorderBox ? "border" : "content"), valueIsBorderBox, styles)) + "px";
  }
  function showHide(elements, show) {
    var display,
        elem,
        hidden,
        values = [],
        index = 0,
        length = elements.length;
    for (; index < length; index++) {
      elem = elements[index];
      if (!elem.style) {
        continue;
      }
      values[index] = data_priv.get(elem, "olddisplay");
      display = elem.style.display;
      if (show) {
        if (!values[index] && display === "none") {
          elem.style.display = "";
        }
        if (elem.style.display === "" && isHidden(elem)) {
          values[index] = data_priv.access(elem, "olddisplay", defaultDisplay(elem.nodeName));
        }
      } else {
        hidden = isHidden(elem);
        if (display !== "none" || !hidden) {
          data_priv.set(elem, "olddisplay", hidden ? display : jQuery.css(elem, "display"));
        }
      }
    }
    for (index = 0; index < length; index++) {
      elem = elements[index];
      if (!elem.style) {
        continue;
      }
      if (!show || elem.style.display === "none" || elem.style.display === "") {
        elem.style.display = show ? values[index] || "" : "none";
      }
    }
    return elements;
  }
  jQuery.extend({
    cssHooks: {opacity: {get: function(elem, computed) {
          if (computed) {
            var ret = curCSS(elem, "opacity");
            return ret === "" ? "1" : ret;
          }
        }}},
    cssNumber: {
      "columnCount": true,
      "fillOpacity": true,
      "flexGrow": true,
      "flexShrink": true,
      "fontWeight": true,
      "lineHeight": true,
      "opacity": true,
      "order": true,
      "orphans": true,
      "widows": true,
      "zIndex": true,
      "zoom": true
    },
    cssProps: {"float": "cssFloat"},
    style: function(elem, name, value, extra) {
      if (!elem || elem.nodeType === 3 || elem.nodeType === 8 || !elem.style) {
        return ;
      }
      var ret,
          type,
          hooks,
          origName = jQuery.camelCase(name),
          style = elem.style;
      name = jQuery.cssProps[origName] || (jQuery.cssProps[origName] = vendorPropName(style, origName));
      hooks = jQuery.cssHooks[name] || jQuery.cssHooks[origName];
      if (value !== undefined) {
        type = typeof value;
        if (type === "string" && (ret = rrelNum.exec(value))) {
          value = (ret[1] + 1) * ret[2] + parseFloat(jQuery.css(elem, name));
          type = "number";
        }
        if (value == null || value !== value) {
          return ;
        }
        if (type === "number" && !jQuery.cssNumber[origName]) {
          value += "px";
        }
        if (!support.clearCloneStyle && value === "" && name.indexOf("background") === 0) {
          style[name] = "inherit";
        }
        if (!hooks || !("set" in hooks) || (value = hooks.set(elem, value, extra)) !== undefined) {
          style[name] = value;
        }
      } else {
        if (hooks && "get" in hooks && (ret = hooks.get(elem, false, extra)) !== undefined) {
          return ret;
        }
        return style[name];
      }
    },
    css: function(elem, name, extra, styles) {
      var val,
          num,
          hooks,
          origName = jQuery.camelCase(name);
      name = jQuery.cssProps[origName] || (jQuery.cssProps[origName] = vendorPropName(elem.style, origName));
      hooks = jQuery.cssHooks[name] || jQuery.cssHooks[origName];
      if (hooks && "get" in hooks) {
        val = hooks.get(elem, true, extra);
      }
      if (val === undefined) {
        val = curCSS(elem, name, styles);
      }
      if (val === "normal" && name in cssNormalTransform) {
        val = cssNormalTransform[name];
      }
      if (extra === "" || extra) {
        num = parseFloat(val);
        return extra === true || jQuery.isNumeric(num) ? num || 0 : val;
      }
      return val;
    }
  });
  jQuery.each(["height", "width"], function(i, name) {
    jQuery.cssHooks[name] = {
      get: function(elem, computed, extra) {
        if (computed) {
          return rdisplayswap.test(jQuery.css(elem, "display")) && elem.offsetWidth === 0 ? jQuery.swap(elem, cssShow, function() {
            return getWidthOrHeight(elem, name, extra);
          }) : getWidthOrHeight(elem, name, extra);
        }
      },
      set: function(elem, value, extra) {
        var styles = extra && getStyles(elem);
        return setPositiveNumber(elem, value, extra ? augmentWidthOrHeight(elem, name, extra, jQuery.css(elem, "boxSizing", false, styles) === "border-box", styles) : 0);
      }
    };
  });
  jQuery.cssHooks.marginRight = addGetHookIf(support.reliableMarginRight, function(elem, computed) {
    if (computed) {
      return jQuery.swap(elem, {"display": "inline-block"}, curCSS, [elem, "marginRight"]);
    }
  });
  jQuery.each({
    margin: "",
    padding: "",
    border: "Width"
  }, function(prefix, suffix) {
    jQuery.cssHooks[prefix + suffix] = {expand: function(value) {
        var i = 0,
            expanded = {},
            parts = typeof value === "string" ? value.split(" ") : [value];
        for (; i < 4; i++) {
          expanded[prefix + cssExpand[i] + suffix] = parts[i] || parts[i - 2] || parts[0];
        }
        return expanded;
      }};
    if (!rmargin.test(prefix)) {
      jQuery.cssHooks[prefix + suffix].set = setPositiveNumber;
    }
  });
  jQuery.fn.extend({
    css: function(name, value) {
      return access(this, function(elem, name, value) {
        var styles,
            len,
            map = {},
            i = 0;
        if (jQuery.isArray(name)) {
          styles = getStyles(elem);
          len = name.length;
          for (; i < len; i++) {
            map[name[i]] = jQuery.css(elem, name[i], false, styles);
          }
          return map;
        }
        return value !== undefined ? jQuery.style(elem, name, value) : jQuery.css(elem, name);
      }, name, value, arguments.length > 1);
    },
    show: function() {
      return showHide(this, true);
    },
    hide: function() {
      return showHide(this);
    },
    toggle: function(state) {
      if (typeof state === "boolean") {
        return state ? this.show() : this.hide();
      }
      return this.each(function() {
        if (isHidden(this)) {
          jQuery(this).show();
        } else {
          jQuery(this).hide();
        }
      });
    }
  });
  function Tween(elem, options, prop, end, easing) {
    return new Tween.prototype.init(elem, options, prop, end, easing);
  }
  jQuery.Tween = Tween;
  Tween.prototype = {
    constructor: Tween,
    init: function(elem, options, prop, end, easing, unit) {
      this.elem = elem;
      this.prop = prop;
      this.easing = easing || "swing";
      this.options = options;
      this.start = this.now = this.cur();
      this.end = end;
      this.unit = unit || (jQuery.cssNumber[prop] ? "" : "px");
    },
    cur: function() {
      var hooks = Tween.propHooks[this.prop];
      return hooks && hooks.get ? hooks.get(this) : Tween.propHooks._default.get(this);
    },
    run: function(percent) {
      var eased,
          hooks = Tween.propHooks[this.prop];
      if (this.options.duration) {
        this.pos = eased = jQuery.easing[this.easing](percent, this.options.duration * percent, 0, 1, this.options.duration);
      } else {
        this.pos = eased = percent;
      }
      this.now = (this.end - this.start) * eased + this.start;
      if (this.options.step) {
        this.options.step.call(this.elem, this.now, this);
      }
      if (hooks && hooks.set) {
        hooks.set(this);
      } else {
        Tween.propHooks._default.set(this);
      }
      return this;
    }
  };
  Tween.prototype.init.prototype = Tween.prototype;
  Tween.propHooks = {_default: {
      get: function(tween) {
        var result;
        if (tween.elem[tween.prop] != null && (!tween.elem.style || tween.elem.style[tween.prop] == null)) {
          return tween.elem[tween.prop];
        }
        result = jQuery.css(tween.elem, tween.prop, "");
        return !result || result === "auto" ? 0 : result;
      },
      set: function(tween) {
        if (jQuery.fx.step[tween.prop]) {
          jQuery.fx.step[tween.prop](tween);
        } else if (tween.elem.style && (tween.elem.style[jQuery.cssProps[tween.prop]] != null || jQuery.cssHooks[tween.prop])) {
          jQuery.style(tween.elem, tween.prop, tween.now + tween.unit);
        } else {
          tween.elem[tween.prop] = tween.now;
        }
      }
    }};
  Tween.propHooks.scrollTop = Tween.propHooks.scrollLeft = {set: function(tween) {
      if (tween.elem.nodeType && tween.elem.parentNode) {
        tween.elem[tween.prop] = tween.now;
      }
    }};
  jQuery.easing = {
    linear: function(p) {
      return p;
    },
    swing: function(p) {
      return 0.5 - Math.cos(p * Math.PI) / 2;
    }
  };
  jQuery.fx = Tween.prototype.init;
  jQuery.fx.step = {};
  var fxNow,
      timerId,
      rfxtypes = /^(?:toggle|show|hide)$/,
      rfxnum = new RegExp("^(?:([+-])=|)(" + pnum + ")([a-z%]*)$", "i"),
      rrun = /queueHooks$/,
      animationPrefilters = [defaultPrefilter],
      tweeners = {"*": [function(prop, value) {
          var tween = this.createTween(prop, value),
              target = tween.cur(),
              parts = rfxnum.exec(value),
              unit = parts && parts[3] || (jQuery.cssNumber[prop] ? "" : "px"),
              start = (jQuery.cssNumber[prop] || unit !== "px" && +target) && rfxnum.exec(jQuery.css(tween.elem, prop)),
              scale = 1,
              maxIterations = 20;
          if (start && start[3] !== unit) {
            unit = unit || start[3];
            parts = parts || [];
            start = +target || 1;
            do {
              scale = scale || ".5";
              start = start / scale;
              jQuery.style(tween.elem, prop, start + unit);
            } while (scale !== (scale = tween.cur() / target) && scale !== 1 && --maxIterations);
          }
          if (parts) {
            start = tween.start = +start || +target || 0;
            tween.unit = unit;
            tween.end = parts[1] ? start + (parts[1] + 1) * parts[2] : +parts[2];
          }
          return tween;
        }]};
  function createFxNow() {
    setTimeout(function() {
      fxNow = undefined;
    });
    return (fxNow = jQuery.now());
  }
  function genFx(type, includeWidth) {
    var which,
        i = 0,
        attrs = {height: type};
    includeWidth = includeWidth ? 1 : 0;
    for (; i < 4; i += 2 - includeWidth) {
      which = cssExpand[i];
      attrs["margin" + which] = attrs["padding" + which] = type;
    }
    if (includeWidth) {
      attrs.opacity = attrs.width = type;
    }
    return attrs;
  }
  function createTween(value, prop, animation) {
    var tween,
        collection = (tweeners[prop] || []).concat(tweeners["*"]),
        index = 0,
        length = collection.length;
    for (; index < length; index++) {
      if ((tween = collection[index].call(animation, prop, value))) {
        return tween;
      }
    }
  }
  function defaultPrefilter(elem, props, opts) {
    var prop,
        value,
        toggle,
        tween,
        hooks,
        oldfire,
        display,
        checkDisplay,
        anim = this,
        orig = {},
        style = elem.style,
        hidden = elem.nodeType && isHidden(elem),
        dataShow = data_priv.get(elem, "fxshow");
    if (!opts.queue) {
      hooks = jQuery._queueHooks(elem, "fx");
      if (hooks.unqueued == null) {
        hooks.unqueued = 0;
        oldfire = hooks.empty.fire;
        hooks.empty.fire = function() {
          if (!hooks.unqueued) {
            oldfire();
          }
        };
      }
      hooks.unqueued++;
      anim.always(function() {
        anim.always(function() {
          hooks.unqueued--;
          if (!jQuery.queue(elem, "fx").length) {
            hooks.empty.fire();
          }
        });
      });
    }
    if (elem.nodeType === 1 && ("height" in props || "width" in props)) {
      opts.overflow = [style.overflow, style.overflowX, style.overflowY];
      display = jQuery.css(elem, "display");
      checkDisplay = display === "none" ? data_priv.get(elem, "olddisplay") || defaultDisplay(elem.nodeName) : display;
      if (checkDisplay === "inline" && jQuery.css(elem, "float") === "none") {
        style.display = "inline-block";
      }
    }
    if (opts.overflow) {
      style.overflow = "hidden";
      anim.always(function() {
        style.overflow = opts.overflow[0];
        style.overflowX = opts.overflow[1];
        style.overflowY = opts.overflow[2];
      });
    }
    for (prop in props) {
      value = props[prop];
      if (rfxtypes.exec(value)) {
        delete props[prop];
        toggle = toggle || value === "toggle";
        if (value === (hidden ? "hide" : "show")) {
          if (value === "show" && dataShow && dataShow[prop] !== undefined) {
            hidden = true;
          } else {
            continue;
          }
        }
        orig[prop] = dataShow && dataShow[prop] || jQuery.style(elem, prop);
      } else {
        display = undefined;
      }
    }
    if (!jQuery.isEmptyObject(orig)) {
      if (dataShow) {
        if ("hidden" in dataShow) {
          hidden = dataShow.hidden;
        }
      } else {
        dataShow = data_priv.access(elem, "fxshow", {});
      }
      if (toggle) {
        dataShow.hidden = !hidden;
      }
      if (hidden) {
        jQuery(elem).show();
      } else {
        anim.done(function() {
          jQuery(elem).hide();
        });
      }
      anim.done(function() {
        var prop;
        data_priv.remove(elem, "fxshow");
        for (prop in orig) {
          jQuery.style(elem, prop, orig[prop]);
        }
      });
      for (prop in orig) {
        tween = createTween(hidden ? dataShow[prop] : 0, prop, anim);
        if (!(prop in dataShow)) {
          dataShow[prop] = tween.start;
          if (hidden) {
            tween.end = tween.start;
            tween.start = prop === "width" || prop === "height" ? 1 : 0;
          }
        }
      }
    } else if ((display === "none" ? defaultDisplay(elem.nodeName) : display) === "inline") {
      style.display = display;
    }
  }
  function propFilter(props, specialEasing) {
    var index,
        name,
        easing,
        value,
        hooks;
    for (index in props) {
      name = jQuery.camelCase(index);
      easing = specialEasing[name];
      value = props[index];
      if (jQuery.isArray(value)) {
        easing = value[1];
        value = props[index] = value[0];
      }
      if (index !== name) {
        props[name] = value;
        delete props[index];
      }
      hooks = jQuery.cssHooks[name];
      if (hooks && "expand" in hooks) {
        value = hooks.expand(value);
        delete props[name];
        for (index in value) {
          if (!(index in props)) {
            props[index] = value[index];
            specialEasing[index] = easing;
          }
        }
      } else {
        specialEasing[name] = easing;
      }
    }
  }
  function Animation(elem, properties, options) {
    var result,
        stopped,
        index = 0,
        length = animationPrefilters.length,
        deferred = jQuery.Deferred().always(function() {
          delete tick.elem;
        }),
        tick = function() {
          if (stopped) {
            return false;
          }
          var currentTime = fxNow || createFxNow(),
              remaining = Math.max(0, animation.startTime + animation.duration - currentTime),
              temp = remaining / animation.duration || 0,
              percent = 1 - temp,
              index = 0,
              length = animation.tweens.length;
          for (; index < length; index++) {
            animation.tweens[index].run(percent);
          }
          deferred.notifyWith(elem, [animation, percent, remaining]);
          if (percent < 1 && length) {
            return remaining;
          } else {
            deferred.resolveWith(elem, [animation]);
            return false;
          }
        },
        animation = deferred.promise({
          elem: elem,
          props: jQuery.extend({}, properties),
          opts: jQuery.extend(true, {specialEasing: {}}, options),
          originalProperties: properties,
          originalOptions: options,
          startTime: fxNow || createFxNow(),
          duration: options.duration,
          tweens: [],
          createTween: function(prop, end) {
            var tween = jQuery.Tween(elem, animation.opts, prop, end, animation.opts.specialEasing[prop] || animation.opts.easing);
            animation.tweens.push(tween);
            return tween;
          },
          stop: function(gotoEnd) {
            var index = 0,
                length = gotoEnd ? animation.tweens.length : 0;
            if (stopped) {
              return this;
            }
            stopped = true;
            for (; index < length; index++) {
              animation.tweens[index].run(1);
            }
            if (gotoEnd) {
              deferred.resolveWith(elem, [animation, gotoEnd]);
            } else {
              deferred.rejectWith(elem, [animation, gotoEnd]);
            }
            return this;
          }
        }),
        props = animation.props;
    propFilter(props, animation.opts.specialEasing);
    for (; index < length; index++) {
      result = animationPrefilters[index].call(animation, elem, props, animation.opts);
      if (result) {
        return result;
      }
    }
    jQuery.map(props, createTween, animation);
    if (jQuery.isFunction(animation.opts.start)) {
      animation.opts.start.call(elem, animation);
    }
    jQuery.fx.timer(jQuery.extend(tick, {
      elem: elem,
      anim: animation,
      queue: animation.opts.queue
    }));
    return animation.progress(animation.opts.progress).done(animation.opts.done, animation.opts.complete).fail(animation.opts.fail).always(animation.opts.always);
  }
  jQuery.Animation = jQuery.extend(Animation, {
    tweener: function(props, callback) {
      if (jQuery.isFunction(props)) {
        callback = props;
        props = ["*"];
      } else {
        props = props.split(" ");
      }
      var prop,
          index = 0,
          length = props.length;
      for (; index < length; index++) {
        prop = props[index];
        tweeners[prop] = tweeners[prop] || [];
        tweeners[prop].unshift(callback);
      }
    },
    prefilter: function(callback, prepend) {
      if (prepend) {
        animationPrefilters.unshift(callback);
      } else {
        animationPrefilters.push(callback);
      }
    }
  });
  jQuery.speed = function(speed, easing, fn) {
    var opt = speed && typeof speed === "object" ? jQuery.extend({}, speed) : {
      complete: fn || !fn && easing || jQuery.isFunction(speed) && speed,
      duration: speed,
      easing: fn && easing || easing && !jQuery.isFunction(easing) && easing
    };
    opt.duration = jQuery.fx.off ? 0 : typeof opt.duration === "number" ? opt.duration : opt.duration in jQuery.fx.speeds ? jQuery.fx.speeds[opt.duration] : jQuery.fx.speeds._default;
    if (opt.queue == null || opt.queue === true) {
      opt.queue = "fx";
    }
    opt.old = opt.complete;
    opt.complete = function() {
      if (jQuery.isFunction(opt.old)) {
        opt.old.call(this);
      }
      if (opt.queue) {
        jQuery.dequeue(this, opt.queue);
      }
    };
    return opt;
  };
  jQuery.fn.extend({
    fadeTo: function(speed, to, easing, callback) {
      return this.filter(isHidden).css("opacity", 0).show().end().animate({opacity: to}, speed, easing, callback);
    },
    animate: function(prop, speed, easing, callback) {
      var empty = jQuery.isEmptyObject(prop),
          optall = jQuery.speed(speed, easing, callback),
          doAnimation = function() {
            var anim = Animation(this, jQuery.extend({}, prop), optall);
            if (empty || data_priv.get(this, "finish")) {
              anim.stop(true);
            }
          };
      doAnimation.finish = doAnimation;
      return empty || optall.queue === false ? this.each(doAnimation) : this.queue(optall.queue, doAnimation);
    },
    stop: function(type, clearQueue, gotoEnd) {
      var stopQueue = function(hooks) {
        var stop = hooks.stop;
        delete hooks.stop;
        stop(gotoEnd);
      };
      if (typeof type !== "string") {
        gotoEnd = clearQueue;
        clearQueue = type;
        type = undefined;
      }
      if (clearQueue && type !== false) {
        this.queue(type || "fx", []);
      }
      return this.each(function() {
        var dequeue = true,
            index = type != null && type + "queueHooks",
            timers = jQuery.timers,
            data = data_priv.get(this);
        if (index) {
          if (data[index] && data[index].stop) {
            stopQueue(data[index]);
          }
        } else {
          for (index in data) {
            if (data[index] && data[index].stop && rrun.test(index)) {
              stopQueue(data[index]);
            }
          }
        }
        for (index = timers.length; index--; ) {
          if (timers[index].elem === this && (type == null || timers[index].queue === type)) {
            timers[index].anim.stop(gotoEnd);
            dequeue = false;
            timers.splice(index, 1);
          }
        }
        if (dequeue || !gotoEnd) {
          jQuery.dequeue(this, type);
        }
      });
    },
    finish: function(type) {
      if (type !== false) {
        type = type || "fx";
      }
      return this.each(function() {
        var index,
            data = data_priv.get(this),
            queue = data[type + "queue"],
            hooks = data[type + "queueHooks"],
            timers = jQuery.timers,
            length = queue ? queue.length : 0;
        data.finish = true;
        jQuery.queue(this, type, []);
        if (hooks && hooks.stop) {
          hooks.stop.call(this, true);
        }
        for (index = timers.length; index--; ) {
          if (timers[index].elem === this && timers[index].queue === type) {
            timers[index].anim.stop(true);
            timers.splice(index, 1);
          }
        }
        for (index = 0; index < length; index++) {
          if (queue[index] && queue[index].finish) {
            queue[index].finish.call(this);
          }
        }
        delete data.finish;
      });
    }
  });
  jQuery.each(["toggle", "show", "hide"], function(i, name) {
    var cssFn = jQuery.fn[name];
    jQuery.fn[name] = function(speed, easing, callback) {
      return speed == null || typeof speed === "boolean" ? cssFn.apply(this, arguments) : this.animate(genFx(name, true), speed, easing, callback);
    };
  });
  jQuery.each({
    slideDown: genFx("show"),
    slideUp: genFx("hide"),
    slideToggle: genFx("toggle"),
    fadeIn: {opacity: "show"},
    fadeOut: {opacity: "hide"},
    fadeToggle: {opacity: "toggle"}
  }, function(name, props) {
    jQuery.fn[name] = function(speed, easing, callback) {
      return this.animate(props, speed, easing, callback);
    };
  });
  jQuery.timers = [];
  jQuery.fx.tick = function() {
    var timer,
        i = 0,
        timers = jQuery.timers;
    fxNow = jQuery.now();
    for (; i < timers.length; i++) {
      timer = timers[i];
      if (!timer() && timers[i] === timer) {
        timers.splice(i--, 1);
      }
    }
    if (!timers.length) {
      jQuery.fx.stop();
    }
    fxNow = undefined;
  };
  jQuery.fx.timer = function(timer) {
    jQuery.timers.push(timer);
    if (timer()) {
      jQuery.fx.start();
    } else {
      jQuery.timers.pop();
    }
  };
  jQuery.fx.interval = 13;
  jQuery.fx.start = function() {
    if (!timerId) {
      timerId = setInterval(jQuery.fx.tick, jQuery.fx.interval);
    }
  };
  jQuery.fx.stop = function() {
    clearInterval(timerId);
    timerId = null;
  };
  jQuery.fx.speeds = {
    slow: 600,
    fast: 200,
    _default: 400
  };
  jQuery.fn.delay = function(time, type) {
    time = jQuery.fx ? jQuery.fx.speeds[time] || time : time;
    type = type || "fx";
    return this.queue(type, function(next, hooks) {
      var timeout = setTimeout(next, time);
      hooks.stop = function() {
        clearTimeout(timeout);
      };
    });
  };
  (function() {
    var input = document.createElement("input"),
        select = document.createElement("select"),
        opt = select.appendChild(document.createElement("option"));
    input.type = "checkbox";
    support.checkOn = input.value !== "";
    support.optSelected = opt.selected;
    select.disabled = true;
    support.optDisabled = !opt.disabled;
    input = document.createElement("input");
    input.value = "t";
    input.type = "radio";
    support.radioValue = input.value === "t";
  })();
  var nodeHook,
      boolHook,
      attrHandle = jQuery.expr.attrHandle;
  jQuery.fn.extend({
    attr: function(name, value) {
      return access(this, jQuery.attr, name, value, arguments.length > 1);
    },
    removeAttr: function(name) {
      return this.each(function() {
        jQuery.removeAttr(this, name);
      });
    }
  });
  jQuery.extend({
    attr: function(elem, name, value) {
      var hooks,
          ret,
          nType = elem.nodeType;
      if (!elem || nType === 3 || nType === 8 || nType === 2) {
        return ;
      }
      if (typeof elem.getAttribute === strundefined) {
        return jQuery.prop(elem, name, value);
      }
      if (nType !== 1 || !jQuery.isXMLDoc(elem)) {
        name = name.toLowerCase();
        hooks = jQuery.attrHooks[name] || (jQuery.expr.match.bool.test(name) ? boolHook : nodeHook);
      }
      if (value !== undefined) {
        if (value === null) {
          jQuery.removeAttr(elem, name);
        } else if (hooks && "set" in hooks && (ret = hooks.set(elem, value, name)) !== undefined) {
          return ret;
        } else {
          elem.setAttribute(name, value + "");
          return value;
        }
      } else if (hooks && "get" in hooks && (ret = hooks.get(elem, name)) !== null) {
        return ret;
      } else {
        ret = jQuery.find.attr(elem, name);
        return ret == null ? undefined : ret;
      }
    },
    removeAttr: function(elem, value) {
      var name,
          propName,
          i = 0,
          attrNames = value && value.match(rnotwhite);
      if (attrNames && elem.nodeType === 1) {
        while ((name = attrNames[i++])) {
          propName = jQuery.propFix[name] || name;
          if (jQuery.expr.match.bool.test(name)) {
            elem[propName] = false;
          }
          elem.removeAttribute(name);
        }
      }
    },
    attrHooks: {type: {set: function(elem, value) {
          if (!support.radioValue && value === "radio" && jQuery.nodeName(elem, "input")) {
            var val = elem.value;
            elem.setAttribute("type", value);
            if (val) {
              elem.value = val;
            }
            return value;
          }
        }}}
  });
  boolHook = {set: function(elem, value, name) {
      if (value === false) {
        jQuery.removeAttr(elem, name);
      } else {
        elem.setAttribute(name, name);
      }
      return name;
    }};
  jQuery.each(jQuery.expr.match.bool.source.match(/\w+/g), function(i, name) {
    var getter = attrHandle[name] || jQuery.find.attr;
    attrHandle[name] = function(elem, name, isXML) {
      var ret,
          handle;
      if (!isXML) {
        handle = attrHandle[name];
        attrHandle[name] = ret;
        ret = getter(elem, name, isXML) != null ? name.toLowerCase() : null;
        attrHandle[name] = handle;
      }
      return ret;
    };
  });
  var rfocusable = /^(?:input|select|textarea|button)$/i;
  jQuery.fn.extend({
    prop: function(name, value) {
      return access(this, jQuery.prop, name, value, arguments.length > 1);
    },
    removeProp: function(name) {
      return this.each(function() {
        delete this[jQuery.propFix[name] || name];
      });
    }
  });
  jQuery.extend({
    propFix: {
      "for": "htmlFor",
      "class": "className"
    },
    prop: function(elem, name, value) {
      var ret,
          hooks,
          notxml,
          nType = elem.nodeType;
      if (!elem || nType === 3 || nType === 8 || nType === 2) {
        return ;
      }
      notxml = nType !== 1 || !jQuery.isXMLDoc(elem);
      if (notxml) {
        name = jQuery.propFix[name] || name;
        hooks = jQuery.propHooks[name];
      }
      if (value !== undefined) {
        return hooks && "set" in hooks && (ret = hooks.set(elem, value, name)) !== undefined ? ret : (elem[name] = value);
      } else {
        return hooks && "get" in hooks && (ret = hooks.get(elem, name)) !== null ? ret : elem[name];
      }
    },
    propHooks: {tabIndex: {get: function(elem) {
          return elem.hasAttribute("tabindex") || rfocusable.test(elem.nodeName) || elem.href ? elem.tabIndex : -1;
        }}}
  });
  if (!support.optSelected) {
    jQuery.propHooks.selected = {get: function(elem) {
        var parent = elem.parentNode;
        if (parent && parent.parentNode) {
          parent.parentNode.selectedIndex;
        }
        return null;
      }};
  }
  jQuery.each(["tabIndex", "readOnly", "maxLength", "cellSpacing", "cellPadding", "rowSpan", "colSpan", "useMap", "frameBorder", "contentEditable"], function() {
    jQuery.propFix[this.toLowerCase()] = this;
  });
  var rclass = /[\t\r\n\f]/g;
  jQuery.fn.extend({
    addClass: function(value) {
      var classes,
          elem,
          cur,
          clazz,
          j,
          finalValue,
          proceed = typeof value === "string" && value,
          i = 0,
          len = this.length;
      if (jQuery.isFunction(value)) {
        return this.each(function(j) {
          jQuery(this).addClass(value.call(this, j, this.className));
        });
      }
      if (proceed) {
        classes = (value || "").match(rnotwhite) || [];
        for (; i < len; i++) {
          elem = this[i];
          cur = elem.nodeType === 1 && (elem.className ? (" " + elem.className + " ").replace(rclass, " ") : " ");
          if (cur) {
            j = 0;
            while ((clazz = classes[j++])) {
              if (cur.indexOf(" " + clazz + " ") < 0) {
                cur += clazz + " ";
              }
            }
            finalValue = jQuery.trim(cur);
            if (elem.className !== finalValue) {
              elem.className = finalValue;
            }
          }
        }
      }
      return this;
    },
    removeClass: function(value) {
      var classes,
          elem,
          cur,
          clazz,
          j,
          finalValue,
          proceed = arguments.length === 0 || typeof value === "string" && value,
          i = 0,
          len = this.length;
      if (jQuery.isFunction(value)) {
        return this.each(function(j) {
          jQuery(this).removeClass(value.call(this, j, this.className));
        });
      }
      if (proceed) {
        classes = (value || "").match(rnotwhite) || [];
        for (; i < len; i++) {
          elem = this[i];
          cur = elem.nodeType === 1 && (elem.className ? (" " + elem.className + " ").replace(rclass, " ") : "");
          if (cur) {
            j = 0;
            while ((clazz = classes[j++])) {
              while (cur.indexOf(" " + clazz + " ") >= 0) {
                cur = cur.replace(" " + clazz + " ", " ");
              }
            }
            finalValue = value ? jQuery.trim(cur) : "";
            if (elem.className !== finalValue) {
              elem.className = finalValue;
            }
          }
        }
      }
      return this;
    },
    toggleClass: function(value, stateVal) {
      var type = typeof value;
      if (typeof stateVal === "boolean" && type === "string") {
        return stateVal ? this.addClass(value) : this.removeClass(value);
      }
      if (jQuery.isFunction(value)) {
        return this.each(function(i) {
          jQuery(this).toggleClass(value.call(this, i, this.className, stateVal), stateVal);
        });
      }
      return this.each(function() {
        if (type === "string") {
          var className,
              i = 0,
              self = jQuery(this),
              classNames = value.match(rnotwhite) || [];
          while ((className = classNames[i++])) {
            if (self.hasClass(className)) {
              self.removeClass(className);
            } else {
              self.addClass(className);
            }
          }
        } else if (type === strundefined || type === "boolean") {
          if (this.className) {
            data_priv.set(this, "__className__", this.className);
          }
          this.className = this.className || value === false ? "" : data_priv.get(this, "__className__") || "";
        }
      });
    },
    hasClass: function(selector) {
      var className = " " + selector + " ",
          i = 0,
          l = this.length;
      for (; i < l; i++) {
        if (this[i].nodeType === 1 && (" " + this[i].className + " ").replace(rclass, " ").indexOf(className) >= 0) {
          return true;
        }
      }
      return false;
    }
  });
  var rreturn = /\r/g;
  jQuery.fn.extend({val: function(value) {
      var hooks,
          ret,
          isFunction,
          elem = this[0];
      if (!arguments.length) {
        if (elem) {
          hooks = jQuery.valHooks[elem.type] || jQuery.valHooks[elem.nodeName.toLowerCase()];
          if (hooks && "get" in hooks && (ret = hooks.get(elem, "value")) !== undefined) {
            return ret;
          }
          ret = elem.value;
          return typeof ret === "string" ? ret.replace(rreturn, "") : ret == null ? "" : ret;
        }
        return ;
      }
      isFunction = jQuery.isFunction(value);
      return this.each(function(i) {
        var val;
        if (this.nodeType !== 1) {
          return ;
        }
        if (isFunction) {
          val = value.call(this, i, jQuery(this).val());
        } else {
          val = value;
        }
        if (val == null) {
          val = "";
        } else if (typeof val === "number") {
          val += "";
        } else if (jQuery.isArray(val)) {
          val = jQuery.map(val, function(value) {
            return value == null ? "" : value + "";
          });
        }
        hooks = jQuery.valHooks[this.type] || jQuery.valHooks[this.nodeName.toLowerCase()];
        if (!hooks || !("set" in hooks) || hooks.set(this, val, "value") === undefined) {
          this.value = val;
        }
      });
    }});
  jQuery.extend({valHooks: {
      option: {get: function(elem) {
          var val = jQuery.find.attr(elem, "value");
          return val != null ? val : jQuery.trim(jQuery.text(elem));
        }},
      select: {
        get: function(elem) {
          var value,
              option,
              options = elem.options,
              index = elem.selectedIndex,
              one = elem.type === "select-one" || index < 0,
              values = one ? null : [],
              max = one ? index + 1 : options.length,
              i = index < 0 ? max : one ? index : 0;
          for (; i < max; i++) {
            option = options[i];
            if ((option.selected || i === index) && (support.optDisabled ? !option.disabled : option.getAttribute("disabled") === null) && (!option.parentNode.disabled || !jQuery.nodeName(option.parentNode, "optgroup"))) {
              value = jQuery(option).val();
              if (one) {
                return value;
              }
              values.push(value);
            }
          }
          return values;
        },
        set: function(elem, value) {
          var optionSet,
              option,
              options = elem.options,
              values = jQuery.makeArray(value),
              i = options.length;
          while (i--) {
            option = options[i];
            if ((option.selected = jQuery.inArray(option.value, values) >= 0)) {
              optionSet = true;
            }
          }
          if (!optionSet) {
            elem.selectedIndex = -1;
          }
          return values;
        }
      }
    }});
  jQuery.each(["radio", "checkbox"], function() {
    jQuery.valHooks[this] = {set: function(elem, value) {
        if (jQuery.isArray(value)) {
          return (elem.checked = jQuery.inArray(jQuery(elem).val(), value) >= 0);
        }
      }};
    if (!support.checkOn) {
      jQuery.valHooks[this].get = function(elem) {
        return elem.getAttribute("value") === null ? "on" : elem.value;
      };
    }
  });
  jQuery.each(("blur focus focusin focusout load resize scroll unload click dblclick " + "mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave " + "change select submit keydown keypress keyup error contextmenu").split(" "), function(i, name) {
    jQuery.fn[name] = function(data, fn) {
      return arguments.length > 0 ? this.on(name, null, data, fn) : this.trigger(name);
    };
  });
  jQuery.fn.extend({
    hover: function(fnOver, fnOut) {
      return this.mouseenter(fnOver).mouseleave(fnOut || fnOver);
    },
    bind: function(types, data, fn) {
      return this.on(types, null, data, fn);
    },
    unbind: function(types, fn) {
      return this.off(types, null, fn);
    },
    delegate: function(selector, types, data, fn) {
      return this.on(types, selector, data, fn);
    },
    undelegate: function(selector, types, fn) {
      return arguments.length === 1 ? this.off(selector, "**") : this.off(types, selector || "**", fn);
    }
  });
  var nonce = jQuery.now();
  var rquery = (/\?/);
  jQuery.parseJSON = function(data) {
    return JSON.parse(data + "");
  };
  jQuery.parseXML = function(data) {
    var xml,
        tmp;
    if (!data || typeof data !== "string") {
      return null;
    }
    try {
      tmp = new DOMParser();
      xml = tmp.parseFromString(data, "text/xml");
    } catch (e) {
      xml = undefined;
    }
    if (!xml || xml.getElementsByTagName("parsererror").length) {
      jQuery.error("Invalid XML: " + data);
    }
    return xml;
  };
  var rhash = /#.*$/,
      rts = /([?&])_=[^&]*/,
      rheaders = /^(.*?):[ \t]*([^\r\n]*)$/mg,
      rlocalProtocol = /^(?:about|app|app-storage|.+-extension|file|res|widget):$/,
      rnoContent = /^(?:GET|HEAD)$/,
      rprotocol = /^\/\//,
      rurl = /^([\w.+-]+:)(?:\/\/(?:[^\/?#]*@|)([^\/?#:]*)(?::(\d+)|)|)/,
      prefilters = {},
      transports = {},
      allTypes = "*/".concat("*"),
      ajaxLocation = window.location.href,
      ajaxLocParts = rurl.exec(ajaxLocation.toLowerCase()) || [];
  function addToPrefiltersOrTransports(structure) {
    return function(dataTypeExpression, func) {
      if (typeof dataTypeExpression !== "string") {
        func = dataTypeExpression;
        dataTypeExpression = "*";
      }
      var dataType,
          i = 0,
          dataTypes = dataTypeExpression.toLowerCase().match(rnotwhite) || [];
      if (jQuery.isFunction(func)) {
        while ((dataType = dataTypes[i++])) {
          if (dataType[0] === "+") {
            dataType = dataType.slice(1) || "*";
            (structure[dataType] = structure[dataType] || []).unshift(func);
          } else {
            (structure[dataType] = structure[dataType] || []).push(func);
          }
        }
      }
    };
  }
  function inspectPrefiltersOrTransports(structure, options, originalOptions, jqXHR) {
    var inspected = {},
        seekingTransport = (structure === transports);
    function inspect(dataType) {
      var selected;
      inspected[dataType] = true;
      jQuery.each(structure[dataType] || [], function(_, prefilterOrFactory) {
        var dataTypeOrTransport = prefilterOrFactory(options, originalOptions, jqXHR);
        if (typeof dataTypeOrTransport === "string" && !seekingTransport && !inspected[dataTypeOrTransport]) {
          options.dataTypes.unshift(dataTypeOrTransport);
          inspect(dataTypeOrTransport);
          return false;
        } else if (seekingTransport) {
          return !(selected = dataTypeOrTransport);
        }
      });
      return selected;
    }
    return inspect(options.dataTypes[0]) || !inspected["*"] && inspect("*");
  }
  function ajaxExtend(target, src) {
    var key,
        deep,
        flatOptions = jQuery.ajaxSettings.flatOptions || {};
    for (key in src) {
      if (src[key] !== undefined) {
        (flatOptions[key] ? target : (deep || (deep = {})))[key] = src[key];
      }
    }
    if (deep) {
      jQuery.extend(true, target, deep);
    }
    return target;
  }
  function ajaxHandleResponses(s, jqXHR, responses) {
    var ct,
        type,
        finalDataType,
        firstDataType,
        contents = s.contents,
        dataTypes = s.dataTypes;
    while (dataTypes[0] === "*") {
      dataTypes.shift();
      if (ct === undefined) {
        ct = s.mimeType || jqXHR.getResponseHeader("Content-Type");
      }
    }
    if (ct) {
      for (type in contents) {
        if (contents[type] && contents[type].test(ct)) {
          dataTypes.unshift(type);
          break;
        }
      }
    }
    if (dataTypes[0] in responses) {
      finalDataType = dataTypes[0];
    } else {
      for (type in responses) {
        if (!dataTypes[0] || s.converters[type + " " + dataTypes[0]]) {
          finalDataType = type;
          break;
        }
        if (!firstDataType) {
          firstDataType = type;
        }
      }
      finalDataType = finalDataType || firstDataType;
    }
    if (finalDataType) {
      if (finalDataType !== dataTypes[0]) {
        dataTypes.unshift(finalDataType);
      }
      return responses[finalDataType];
    }
  }
  function ajaxConvert(s, response, jqXHR, isSuccess) {
    var conv2,
        current,
        conv,
        tmp,
        prev,
        converters = {},
        dataTypes = s.dataTypes.slice();
    if (dataTypes[1]) {
      for (conv in s.converters) {
        converters[conv.toLowerCase()] = s.converters[conv];
      }
    }
    current = dataTypes.shift();
    while (current) {
      if (s.responseFields[current]) {
        jqXHR[s.responseFields[current]] = response;
      }
      if (!prev && isSuccess && s.dataFilter) {
        response = s.dataFilter(response, s.dataType);
      }
      prev = current;
      current = dataTypes.shift();
      if (current) {
        if (current === "*") {
          current = prev;
        } else if (prev !== "*" && prev !== current) {
          conv = converters[prev + " " + current] || converters["* " + current];
          if (!conv) {
            for (conv2 in converters) {
              tmp = conv2.split(" ");
              if (tmp[1] === current) {
                conv = converters[prev + " " + tmp[0]] || converters["* " + tmp[0]];
                if (conv) {
                  if (conv === true) {
                    conv = converters[conv2];
                  } else if (converters[conv2] !== true) {
                    current = tmp[0];
                    dataTypes.unshift(tmp[1]);
                  }
                  break;
                }
              }
            }
          }
          if (conv !== true) {
            if (conv && s["throws"]) {
              response = conv(response);
            } else {
              try {
                response = conv(response);
              } catch (e) {
                return {
                  state: "parsererror",
                  error: conv ? e : "No conversion from " + prev + " to " + current
                };
              }
            }
          }
        }
      }
    }
    return {
      state: "success",
      data: response
    };
  }
  jQuery.extend({
    active: 0,
    lastModified: {},
    etag: {},
    ajaxSettings: {
      url: ajaxLocation,
      type: "GET",
      isLocal: rlocalProtocol.test(ajaxLocParts[1]),
      global: true,
      processData: true,
      async: true,
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      accepts: {
        "*": allTypes,
        text: "text/plain",
        html: "text/html",
        xml: "application/xml, text/xml",
        json: "application/json, text/javascript"
      },
      contents: {
        xml: /xml/,
        html: /html/,
        json: /json/
      },
      responseFields: {
        xml: "responseXML",
        text: "responseText",
        json: "responseJSON"
      },
      converters: {
        "* text": String,
        "text html": true,
        "text json": jQuery.parseJSON,
        "text xml": jQuery.parseXML
      },
      flatOptions: {
        url: true,
        context: true
      }
    },
    ajaxSetup: function(target, settings) {
      return settings ? ajaxExtend(ajaxExtend(target, jQuery.ajaxSettings), settings) : ajaxExtend(jQuery.ajaxSettings, target);
    },
    ajaxPrefilter: addToPrefiltersOrTransports(prefilters),
    ajaxTransport: addToPrefiltersOrTransports(transports),
    ajax: function(url, options) {
      if (typeof url === "object") {
        options = url;
        url = undefined;
      }
      options = options || {};
      var transport,
          cacheURL,
          responseHeadersString,
          responseHeaders,
          timeoutTimer,
          parts,
          fireGlobals,
          i,
          s = jQuery.ajaxSetup({}, options),
          callbackContext = s.context || s,
          globalEventContext = s.context && (callbackContext.nodeType || callbackContext.jquery) ? jQuery(callbackContext) : jQuery.event,
          deferred = jQuery.Deferred(),
          completeDeferred = jQuery.Callbacks("once memory"),
          statusCode = s.statusCode || {},
          requestHeaders = {},
          requestHeadersNames = {},
          state = 0,
          strAbort = "canceled",
          jqXHR = {
            readyState: 0,
            getResponseHeader: function(key) {
              var match;
              if (state === 2) {
                if (!responseHeaders) {
                  responseHeaders = {};
                  while ((match = rheaders.exec(responseHeadersString))) {
                    responseHeaders[match[1].toLowerCase()] = match[2];
                  }
                }
                match = responseHeaders[key.toLowerCase()];
              }
              return match == null ? null : match;
            },
            getAllResponseHeaders: function() {
              return state === 2 ? responseHeadersString : null;
            },
            setRequestHeader: function(name, value) {
              var lname = name.toLowerCase();
              if (!state) {
                name = requestHeadersNames[lname] = requestHeadersNames[lname] || name;
                requestHeaders[name] = value;
              }
              return this;
            },
            overrideMimeType: function(type) {
              if (!state) {
                s.mimeType = type;
              }
              return this;
            },
            statusCode: function(map) {
              var code;
              if (map) {
                if (state < 2) {
                  for (code in map) {
                    statusCode[code] = [statusCode[code], map[code]];
                  }
                } else {
                  jqXHR.always(map[jqXHR.status]);
                }
              }
              return this;
            },
            abort: function(statusText) {
              var finalText = statusText || strAbort;
              if (transport) {
                transport.abort(finalText);
              }
              done(0, finalText);
              return this;
            }
          };
      deferred.promise(jqXHR).complete = completeDeferred.add;
      jqXHR.success = jqXHR.done;
      jqXHR.error = jqXHR.fail;
      s.url = ((url || s.url || ajaxLocation) + "").replace(rhash, "").replace(rprotocol, ajaxLocParts[1] + "//");
      s.type = options.method || options.type || s.method || s.type;
      s.dataTypes = jQuery.trim(s.dataType || "*").toLowerCase().match(rnotwhite) || [""];
      if (s.crossDomain == null) {
        parts = rurl.exec(s.url.toLowerCase());
        s.crossDomain = !!(parts && (parts[1] !== ajaxLocParts[1] || parts[2] !== ajaxLocParts[2] || (parts[3] || (parts[1] === "http:" ? "80" : "443")) !== (ajaxLocParts[3] || (ajaxLocParts[1] === "http:" ? "80" : "443"))));
      }
      if (s.data && s.processData && typeof s.data !== "string") {
        s.data = jQuery.param(s.data, s.traditional);
      }
      inspectPrefiltersOrTransports(prefilters, s, options, jqXHR);
      if (state === 2) {
        return jqXHR;
      }
      fireGlobals = jQuery.event && s.global;
      if (fireGlobals && jQuery.active++ === 0) {
        jQuery.event.trigger("ajaxStart");
      }
      s.type = s.type.toUpperCase();
      s.hasContent = !rnoContent.test(s.type);
      cacheURL = s.url;
      if (!s.hasContent) {
        if (s.data) {
          cacheURL = (s.url += (rquery.test(cacheURL) ? "&" : "?") + s.data);
          delete s.data;
        }
        if (s.cache === false) {
          s.url = rts.test(cacheURL) ? cacheURL.replace(rts, "$1_=" + nonce++) : cacheURL + (rquery.test(cacheURL) ? "&" : "?") + "_=" + nonce++;
        }
      }
      if (s.ifModified) {
        if (jQuery.lastModified[cacheURL]) {
          jqXHR.setRequestHeader("If-Modified-Since", jQuery.lastModified[cacheURL]);
        }
        if (jQuery.etag[cacheURL]) {
          jqXHR.setRequestHeader("If-None-Match", jQuery.etag[cacheURL]);
        }
      }
      if (s.data && s.hasContent && s.contentType !== false || options.contentType) {
        jqXHR.setRequestHeader("Content-Type", s.contentType);
      }
      jqXHR.setRequestHeader("Accept", s.dataTypes[0] && s.accepts[s.dataTypes[0]] ? s.accepts[s.dataTypes[0]] + (s.dataTypes[0] !== "*" ? ", " + allTypes + "; q=0.01" : "") : s.accepts["*"]);
      for (i in s.headers) {
        jqXHR.setRequestHeader(i, s.headers[i]);
      }
      if (s.beforeSend && (s.beforeSend.call(callbackContext, jqXHR, s) === false || state === 2)) {
        return jqXHR.abort();
      }
      strAbort = "abort";
      for (i in {
        success: 1,
        error: 1,
        complete: 1
      }) {
        jqXHR[i](s[i]);
      }
      transport = inspectPrefiltersOrTransports(transports, s, options, jqXHR);
      if (!transport) {
        done(-1, "No Transport");
      } else {
        jqXHR.readyState = 1;
        if (fireGlobals) {
          globalEventContext.trigger("ajaxSend", [jqXHR, s]);
        }
        if (s.async && s.timeout > 0) {
          timeoutTimer = setTimeout(function() {
            jqXHR.abort("timeout");
          }, s.timeout);
        }
        try {
          state = 1;
          transport.send(requestHeaders, done);
        } catch (e) {
          if (state < 2) {
            done(-1, e);
          } else {
            throw e;
          }
        }
      }
      function done(status, nativeStatusText, responses, headers) {
        var isSuccess,
            success,
            error,
            response,
            modified,
            statusText = nativeStatusText;
        if (state === 2) {
          return ;
        }
        state = 2;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        transport = undefined;
        responseHeadersString = headers || "";
        jqXHR.readyState = status > 0 ? 4 : 0;
        isSuccess = status >= 200 && status < 300 || status === 304;
        if (responses) {
          response = ajaxHandleResponses(s, jqXHR, responses);
        }
        response = ajaxConvert(s, response, jqXHR, isSuccess);
        if (isSuccess) {
          if (s.ifModified) {
            modified = jqXHR.getResponseHeader("Last-Modified");
            if (modified) {
              jQuery.lastModified[cacheURL] = modified;
            }
            modified = jqXHR.getResponseHeader("etag");
            if (modified) {
              jQuery.etag[cacheURL] = modified;
            }
          }
          if (status === 204 || s.type === "HEAD") {
            statusText = "nocontent";
          } else if (status === 304) {
            statusText = "notmodified";
          } else {
            statusText = response.state;
            success = response.data;
            error = response.error;
            isSuccess = !error;
          }
        } else {
          error = statusText;
          if (status || !statusText) {
            statusText = "error";
            if (status < 0) {
              status = 0;
            }
          }
        }
        jqXHR.status = status;
        jqXHR.statusText = (nativeStatusText || statusText) + "";
        if (isSuccess) {
          deferred.resolveWith(callbackContext, [success, statusText, jqXHR]);
        } else {
          deferred.rejectWith(callbackContext, [jqXHR, statusText, error]);
        }
        jqXHR.statusCode(statusCode);
        statusCode = undefined;
        if (fireGlobals) {
          globalEventContext.trigger(isSuccess ? "ajaxSuccess" : "ajaxError", [jqXHR, s, isSuccess ? success : error]);
        }
        completeDeferred.fireWith(callbackContext, [jqXHR, statusText]);
        if (fireGlobals) {
          globalEventContext.trigger("ajaxComplete", [jqXHR, s]);
          if (!(--jQuery.active)) {
            jQuery.event.trigger("ajaxStop");
          }
        }
      }
      return jqXHR;
    },
    getJSON: function(url, data, callback) {
      return jQuery.get(url, data, callback, "json");
    },
    getScript: function(url, callback) {
      return jQuery.get(url, undefined, callback, "script");
    }
  });
  jQuery.each(["get", "post"], function(i, method) {
    jQuery[method] = function(url, data, callback, type) {
      if (jQuery.isFunction(data)) {
        type = type || callback;
        callback = data;
        data = undefined;
      }
      return jQuery.ajax({
        url: url,
        type: method,
        dataType: type,
        data: data,
        success: callback
      });
    };
  });
  jQuery._evalUrl = function(url) {
    return jQuery.ajax({
      url: url,
      type: "GET",
      dataType: "script",
      async: false,
      global: false,
      "throws": true
    });
  };
  jQuery.fn.extend({
    wrapAll: function(html) {
      var wrap;
      if (jQuery.isFunction(html)) {
        return this.each(function(i) {
          jQuery(this).wrapAll(html.call(this, i));
        });
      }
      if (this[0]) {
        wrap = jQuery(html, this[0].ownerDocument).eq(0).clone(true);
        if (this[0].parentNode) {
          wrap.insertBefore(this[0]);
        }
        wrap.map(function() {
          var elem = this;
          while (elem.firstElementChild) {
            elem = elem.firstElementChild;
          }
          return elem;
        }).append(this);
      }
      return this;
    },
    wrapInner: function(html) {
      if (jQuery.isFunction(html)) {
        return this.each(function(i) {
          jQuery(this).wrapInner(html.call(this, i));
        });
      }
      return this.each(function() {
        var self = jQuery(this),
            contents = self.contents();
        if (contents.length) {
          contents.wrapAll(html);
        } else {
          self.append(html);
        }
      });
    },
    wrap: function(html) {
      var isFunction = jQuery.isFunction(html);
      return this.each(function(i) {
        jQuery(this).wrapAll(isFunction ? html.call(this, i) : html);
      });
    },
    unwrap: function() {
      return this.parent().each(function() {
        if (!jQuery.nodeName(this, "body")) {
          jQuery(this).replaceWith(this.childNodes);
        }
      }).end();
    }
  });
  jQuery.expr.filters.hidden = function(elem) {
    return elem.offsetWidth <= 0 && elem.offsetHeight <= 0;
  };
  jQuery.expr.filters.visible = function(elem) {
    return !jQuery.expr.filters.hidden(elem);
  };
  var r20 = /%20/g,
      rbracket = /\[\]$/,
      rCRLF = /\r?\n/g,
      rsubmitterTypes = /^(?:submit|button|image|reset|file)$/i,
      rsubmittable = /^(?:input|select|textarea|keygen)/i;
  function buildParams(prefix, obj, traditional, add) {
    var name;
    if (jQuery.isArray(obj)) {
      jQuery.each(obj, function(i, v) {
        if (traditional || rbracket.test(prefix)) {
          add(prefix, v);
        } else {
          buildParams(prefix + "[" + (typeof v === "object" ? i : "") + "]", v, traditional, add);
        }
      });
    } else if (!traditional && jQuery.type(obj) === "object") {
      for (name in obj) {
        buildParams(prefix + "[" + name + "]", obj[name], traditional, add);
      }
    } else {
      add(prefix, obj);
    }
  }
  jQuery.param = function(a, traditional) {
    var prefix,
        s = [],
        add = function(key, value) {
          value = jQuery.isFunction(value) ? value() : (value == null ? "" : value);
          s[s.length] = encodeURIComponent(key) + "=" + encodeURIComponent(value);
        };
    if (traditional === undefined) {
      traditional = jQuery.ajaxSettings && jQuery.ajaxSettings.traditional;
    }
    if (jQuery.isArray(a) || (a.jquery && !jQuery.isPlainObject(a))) {
      jQuery.each(a, function() {
        add(this.name, this.value);
      });
    } else {
      for (prefix in a) {
        buildParams(prefix, a[prefix], traditional, add);
      }
    }
    return s.join("&").replace(r20, "+");
  };
  jQuery.fn.extend({
    serialize: function() {
      return jQuery.param(this.serializeArray());
    },
    serializeArray: function() {
      return this.map(function() {
        var elements = jQuery.prop(this, "elements");
        return elements ? jQuery.makeArray(elements) : this;
      }).filter(function() {
        var type = this.type;
        return this.name && !jQuery(this).is(":disabled") && rsubmittable.test(this.nodeName) && !rsubmitterTypes.test(type) && (this.checked || !rcheckableType.test(type));
      }).map(function(i, elem) {
        var val = jQuery(this).val();
        return val == null ? null : jQuery.isArray(val) ? jQuery.map(val, function(val) {
          return {
            name: elem.name,
            value: val.replace(rCRLF, "\r\n")
          };
        }) : {
          name: elem.name,
          value: val.replace(rCRLF, "\r\n")
        };
      }).get();
    }
  });
  jQuery.ajaxSettings.xhr = function() {
    try {
      return new XMLHttpRequest();
    } catch (e) {}
  };
  var xhrId = 0,
      xhrCallbacks = {},
      xhrSuccessStatus = {
        0: 200,
        1223: 204
      },
      xhrSupported = jQuery.ajaxSettings.xhr();
  if (window.attachEvent) {
    window.attachEvent("onunload", function() {
      for (var key in xhrCallbacks) {
        xhrCallbacks[key]();
      }
    });
  }
  support.cors = !!xhrSupported && ("withCredentials" in xhrSupported);
  support.ajax = xhrSupported = !!xhrSupported;
  jQuery.ajaxTransport(function(options) {
    var callback;
    if (support.cors || xhrSupported && !options.crossDomain) {
      return {
        send: function(headers, complete) {
          var i,
              xhr = options.xhr(),
              id = ++xhrId;
          xhr.open(options.type, options.url, options.async, options.username, options.password);
          if (options.xhrFields) {
            for (i in options.xhrFields) {
              xhr[i] = options.xhrFields[i];
            }
          }
          if (options.mimeType && xhr.overrideMimeType) {
            xhr.overrideMimeType(options.mimeType);
          }
          if (!options.crossDomain && !headers["X-Requested-With"]) {
            headers["X-Requested-With"] = "XMLHttpRequest";
          }
          for (i in headers) {
            xhr.setRequestHeader(i, headers[i]);
          }
          callback = function(type) {
            return function() {
              if (callback) {
                delete xhrCallbacks[id];
                callback = xhr.onload = xhr.onerror = null;
                if (type === "abort") {
                  xhr.abort();
                } else if (type === "error") {
                  complete(xhr.status, xhr.statusText);
                } else {
                  complete(xhrSuccessStatus[xhr.status] || xhr.status, xhr.statusText, typeof xhr.responseText === "string" ? {text: xhr.responseText} : undefined, xhr.getAllResponseHeaders());
                }
              }
            };
          };
          xhr.onload = callback();
          xhr.onerror = callback("error");
          callback = xhrCallbacks[id] = callback("abort");
          try {
            xhr.send(options.hasContent && options.data || null);
          } catch (e) {
            if (callback) {
              throw e;
            }
          }
        },
        abort: function() {
          if (callback) {
            callback();
          }
        }
      };
    }
  });
  jQuery.ajaxSetup({
    accepts: {script: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript"},
    contents: {script: /(?:java|ecma)script/},
    converters: {"text script": function(text) {
        jQuery.globalEval(text);
        return text;
      }}
  });
  jQuery.ajaxPrefilter("script", function(s) {
    if (s.cache === undefined) {
      s.cache = false;
    }
    if (s.crossDomain) {
      s.type = "GET";
    }
  });
  jQuery.ajaxTransport("script", function(s) {
    if (s.crossDomain) {
      var script,
          callback;
      return {
        send: function(_, complete) {
          script = jQuery("<script>").prop({
            async: true,
            charset: s.scriptCharset,
            src: s.url
          }).on("load error", callback = function(evt) {
            script.remove();
            callback = null;
            if (evt) {
              complete(evt.type === "error" ? 404 : 200, evt.type);
            }
          });
          document.head.appendChild(script[0]);
        },
        abort: function() {
          if (callback) {
            callback();
          }
        }
      };
    }
  });
  var oldCallbacks = [],
      rjsonp = /(=)\?(?=&|$)|\?\?/;
  jQuery.ajaxSetup({
    jsonp: "callback",
    jsonpCallback: function() {
      var callback = oldCallbacks.pop() || (jQuery.expando + "_" + (nonce++));
      this[callback] = true;
      return callback;
    }
  });
  jQuery.ajaxPrefilter("json jsonp", function(s, originalSettings, jqXHR) {
    var callbackName,
        overwritten,
        responseContainer,
        jsonProp = s.jsonp !== false && (rjsonp.test(s.url) ? "url" : typeof s.data === "string" && !(s.contentType || "").indexOf("application/x-www-form-urlencoded") && rjsonp.test(s.data) && "data");
    if (jsonProp || s.dataTypes[0] === "jsonp") {
      callbackName = s.jsonpCallback = jQuery.isFunction(s.jsonpCallback) ? s.jsonpCallback() : s.jsonpCallback;
      if (jsonProp) {
        s[jsonProp] = s[jsonProp].replace(rjsonp, "$1" + callbackName);
      } else if (s.jsonp !== false) {
        s.url += (rquery.test(s.url) ? "&" : "?") + s.jsonp + "=" + callbackName;
      }
      s.converters["script json"] = function() {
        if (!responseContainer) {
          jQuery.error(callbackName + " was not called");
        }
        return responseContainer[0];
      };
      s.dataTypes[0] = "json";
      overwritten = window[callbackName];
      window[callbackName] = function() {
        responseContainer = arguments;
      };
      jqXHR.always(function() {
        window[callbackName] = overwritten;
        if (s[callbackName]) {
          s.jsonpCallback = originalSettings.jsonpCallback;
          oldCallbacks.push(callbackName);
        }
        if (responseContainer && jQuery.isFunction(overwritten)) {
          overwritten(responseContainer[0]);
        }
        responseContainer = overwritten = undefined;
      });
      return "script";
    }
  });
  jQuery.parseHTML = function(data, context, keepScripts) {
    if (!data || typeof data !== "string") {
      return null;
    }
    if (typeof context === "boolean") {
      keepScripts = context;
      context = false;
    }
    context = context || document;
    var parsed = rsingleTag.exec(data),
        scripts = !keepScripts && [];
    if (parsed) {
      return [context.createElement(parsed[1])];
    }
    parsed = jQuery.buildFragment([data], context, scripts);
    if (scripts && scripts.length) {
      jQuery(scripts).remove();
    }
    return jQuery.merge([], parsed.childNodes);
  };
  var _load = jQuery.fn.load;
  jQuery.fn.load = function(url, params, callback) {
    if (typeof url !== "string" && _load) {
      return _load.apply(this, arguments);
    }
    var selector,
        type,
        response,
        self = this,
        off = url.indexOf(" ");
    if (off >= 0) {
      selector = jQuery.trim(url.slice(off));
      url = url.slice(0, off);
    }
    if (jQuery.isFunction(params)) {
      callback = params;
      params = undefined;
    } else if (params && typeof params === "object") {
      type = "POST";
    }
    if (self.length > 0) {
      jQuery.ajax({
        url: url,
        type: type,
        dataType: "html",
        data: params
      }).done(function(responseText) {
        response = arguments;
        self.html(selector ? jQuery("<div>").append(jQuery.parseHTML(responseText)).find(selector) : responseText);
      }).complete(callback && function(jqXHR, status) {
        self.each(callback, response || [jqXHR.responseText, status, jqXHR]);
      });
    }
    return this;
  };
  jQuery.each(["ajaxStart", "ajaxStop", "ajaxComplete", "ajaxError", "ajaxSuccess", "ajaxSend"], function(i, type) {
    jQuery.fn[type] = function(fn) {
      return this.on(type, fn);
    };
  });
  jQuery.expr.filters.animated = function(elem) {
    return jQuery.grep(jQuery.timers, function(fn) {
      return elem === fn.elem;
    }).length;
  };
  var docElem = window.document.documentElement;
  function getWindow(elem) {
    return jQuery.isWindow(elem) ? elem : elem.nodeType === 9 && elem.defaultView;
  }
  jQuery.offset = {setOffset: function(elem, options, i) {
      var curPosition,
          curLeft,
          curCSSTop,
          curTop,
          curOffset,
          curCSSLeft,
          calculatePosition,
          position = jQuery.css(elem, "position"),
          curElem = jQuery(elem),
          props = {};
      if (position === "static") {
        elem.style.position = "relative";
      }
      curOffset = curElem.offset();
      curCSSTop = jQuery.css(elem, "top");
      curCSSLeft = jQuery.css(elem, "left");
      calculatePosition = (position === "absolute" || position === "fixed") && (curCSSTop + curCSSLeft).indexOf("auto") > -1;
      if (calculatePosition) {
        curPosition = curElem.position();
        curTop = curPosition.top;
        curLeft = curPosition.left;
      } else {
        curTop = parseFloat(curCSSTop) || 0;
        curLeft = parseFloat(curCSSLeft) || 0;
      }
      if (jQuery.isFunction(options)) {
        options = options.call(elem, i, curOffset);
      }
      if (options.top != null) {
        props.top = (options.top - curOffset.top) + curTop;
      }
      if (options.left != null) {
        props.left = (options.left - curOffset.left) + curLeft;
      }
      if ("using" in options) {
        options.using.call(elem, props);
      } else {
        curElem.css(props);
      }
    }};
  jQuery.fn.extend({
    offset: function(options) {
      if (arguments.length) {
        return options === undefined ? this : this.each(function(i) {
          jQuery.offset.setOffset(this, options, i);
        });
      }
      var docElem,
          win,
          elem = this[0],
          box = {
            top: 0,
            left: 0
          },
          doc = elem && elem.ownerDocument;
      if (!doc) {
        return ;
      }
      docElem = doc.documentElement;
      if (!jQuery.contains(docElem, elem)) {
        return box;
      }
      if (typeof elem.getBoundingClientRect !== strundefined) {
        box = elem.getBoundingClientRect();
      }
      win = getWindow(doc);
      return {
        top: box.top + win.pageYOffset - docElem.clientTop,
        left: box.left + win.pageXOffset - docElem.clientLeft
      };
    },
    position: function() {
      if (!this[0]) {
        return ;
      }
      var offsetParent,
          offset,
          elem = this[0],
          parentOffset = {
            top: 0,
            left: 0
          };
      if (jQuery.css(elem, "position") === "fixed") {
        offset = elem.getBoundingClientRect();
      } else {
        offsetParent = this.offsetParent();
        offset = this.offset();
        if (!jQuery.nodeName(offsetParent[0], "html")) {
          parentOffset = offsetParent.offset();
        }
        parentOffset.top += jQuery.css(offsetParent[0], "borderTopWidth", true);
        parentOffset.left += jQuery.css(offsetParent[0], "borderLeftWidth", true);
      }
      return {
        top: offset.top - parentOffset.top - jQuery.css(elem, "marginTop", true),
        left: offset.left - parentOffset.left - jQuery.css(elem, "marginLeft", true)
      };
    },
    offsetParent: function() {
      return this.map(function() {
        var offsetParent = this.offsetParent || docElem;
        while (offsetParent && (!jQuery.nodeName(offsetParent, "html") && jQuery.css(offsetParent, "position") === "static")) {
          offsetParent = offsetParent.offsetParent;
        }
        return offsetParent || docElem;
      });
    }
  });
  jQuery.each({
    scrollLeft: "pageXOffset",
    scrollTop: "pageYOffset"
  }, function(method, prop) {
    var top = "pageYOffset" === prop;
    jQuery.fn[method] = function(val) {
      return access(this, function(elem, method, val) {
        var win = getWindow(elem);
        if (val === undefined) {
          return win ? win[prop] : elem[method];
        }
        if (win) {
          win.scrollTo(!top ? val : window.pageXOffset, top ? val : window.pageYOffset);
        } else {
          elem[method] = val;
        }
      }, method, val, arguments.length, null);
    };
  });
  jQuery.each(["top", "left"], function(i, prop) {
    jQuery.cssHooks[prop] = addGetHookIf(support.pixelPosition, function(elem, computed) {
      if (computed) {
        computed = curCSS(elem, prop);
        return rnumnonpx.test(computed) ? jQuery(elem).position()[prop] + "px" : computed;
      }
    });
  });
  jQuery.each({
    Height: "height",
    Width: "width"
  }, function(name, type) {
    jQuery.each({
      padding: "inner" + name,
      content: type,
      "": "outer" + name
    }, function(defaultExtra, funcName) {
      jQuery.fn[funcName] = function(margin, value) {
        var chainable = arguments.length && (defaultExtra || typeof margin !== "boolean"),
            extra = defaultExtra || (margin === true || value === true ? "margin" : "border");
        return access(this, function(elem, type, value) {
          var doc;
          if (jQuery.isWindow(elem)) {
            return elem.document.documentElement["client" + name];
          }
          if (elem.nodeType === 9) {
            doc = elem.documentElement;
            return Math.max(elem.body["scroll" + name], doc["scroll" + name], elem.body["offset" + name], doc["offset" + name], doc["client" + name]);
          }
          return value === undefined ? jQuery.css(elem, type, extra) : jQuery.style(elem, type, value, extra);
        }, type, chainable ? margin : undefined, chainable, null);
      };
    });
  });
  jQuery.fn.size = function() {
    return this.length;
  };
  jQuery.fn.andSelf = jQuery.fn.addBack;
  if (typeof define === "function" && define.amd) {
    System.register("github:components/jquery@2.1.4/jquery", [], false, function(__require, __exports, __module) {
      return (function() {
        return jQuery;
      }).call(this);
    });
  }
  var _jQuery = window.jQuery,
      _$ = window.$;
  jQuery.noConflict = function(deep) {
    if (window.$ === jQuery) {
      window.$ = _$;
    }
    if (deep && window.jQuery === jQuery) {
      window.jQuery = _jQuery;
    }
    return jQuery;
  };
  if (typeof noGlobal === strundefined) {
    window.jQuery = window.$ = jQuery;
  }
  return jQuery;
}));
})();
(function() {
function define(){};  define.amd = {};
(function(f, define) {
  define([], f);
})(function() {
  (function($, window, undefined) {
    var kendo = window.kendo = window.kendo || {cultures: {}},
        extend = $.extend,
        each = $.each,
        isArray = $.isArray,
        proxy = $.proxy,
        noop = $.noop,
        math = Math,
        Template,
        JSON = window.JSON || {},
        support = {},
        percentRegExp = /%/,
        formatRegExp = /\{(\d+)(:[^\}]+)?\}/g,
        boxShadowRegExp = /(\d+(?:\.?)\d*)px\s*(\d+(?:\.?)\d*)px\s*(\d+(?:\.?)\d*)px\s*(\d+)?/i,
        numberRegExp = /^(\+|-?)\d+(\.?)\d*$/,
        FUNCTION = "function",
        STRING = "string",
        NUMBER = "number",
        OBJECT = "object",
        NULL = "null",
        BOOLEAN = "boolean",
        UNDEFINED = "undefined",
        getterCache = {},
        setterCache = {},
        slice = [].slice,
        globalize = window.Globalize;
    kendo.version = "2015.2.727";
    function Class() {}
    Class.extend = function(proto) {
      var base = function() {},
          member,
          that = this,
          subclass = proto && proto.init ? proto.init : function() {
            that.apply(this, arguments);
          },
          fn;
      base.prototype = that.prototype;
      fn = subclass.fn = subclass.prototype = new base();
      for (member in proto) {
        if (proto[member] != null && proto[member].constructor === Object) {
          fn[member] = extend(true, {}, base.prototype[member], proto[member]);
        } else {
          fn[member] = proto[member];
        }
      }
      fn.constructor = subclass;
      subclass.extend = that.extend;
      return subclass;
    };
    Class.prototype._initOptions = function(options) {
      this.options = deepExtend({}, this.options, options);
    };
    var isFunction = kendo.isFunction = function(fn) {
      return typeof fn === "function";
    };
    var preventDefault = function() {
      this._defaultPrevented = true;
    };
    var isDefaultPrevented = function() {
      return this._defaultPrevented === true;
    };
    var Observable = Class.extend({
      init: function() {
        this._events = {};
      },
      bind: function(eventName, handlers, one) {
        var that = this,
            idx,
            eventNames = typeof eventName === STRING ? [eventName] : eventName,
            length,
            original,
            handler,
            handlersIsFunction = typeof handlers === FUNCTION,
            events;
        if (handlers === undefined) {
          for (idx in eventName) {
            that.bind(idx, eventName[idx]);
          }
          return that;
        }
        for (idx = 0, length = eventNames.length; idx < length; idx++) {
          eventName = eventNames[idx];
          handler = handlersIsFunction ? handlers : handlers[eventName];
          if (handler) {
            if (one) {
              original = handler;
              handler = function() {
                that.unbind(eventName, handler);
                original.apply(that, arguments);
              };
              handler.original = original;
            }
            events = that._events[eventName] = that._events[eventName] || [];
            events.push(handler);
          }
        }
        return that;
      },
      one: function(eventNames, handlers) {
        return this.bind(eventNames, handlers, true);
      },
      first: function(eventName, handlers) {
        var that = this,
            idx,
            eventNames = typeof eventName === STRING ? [eventName] : eventName,
            length,
            handler,
            handlersIsFunction = typeof handlers === FUNCTION,
            events;
        for (idx = 0, length = eventNames.length; idx < length; idx++) {
          eventName = eventNames[idx];
          handler = handlersIsFunction ? handlers : handlers[eventName];
          if (handler) {
            events = that._events[eventName] = that._events[eventName] || [];
            events.unshift(handler);
          }
        }
        return that;
      },
      trigger: function(eventName, e) {
        var that = this,
            events = that._events[eventName],
            idx,
            length;
        if (events) {
          e = e || {};
          e.sender = that;
          e._defaultPrevented = false;
          e.preventDefault = preventDefault;
          e.isDefaultPrevented = isDefaultPrevented;
          events = events.slice();
          for (idx = 0, length = events.length; idx < length; idx++) {
            events[idx].call(that, e);
          }
          return e._defaultPrevented === true;
        }
        return false;
      },
      unbind: function(eventName, handler) {
        var that = this,
            events = that._events[eventName],
            idx;
        if (eventName === undefined) {
          that._events = {};
        } else if (events) {
          if (handler) {
            for (idx = events.length - 1; idx >= 0; idx--) {
              if (events[idx] === handler || events[idx].original === handler) {
                events.splice(idx, 1);
              }
            }
          } else {
            that._events[eventName] = [];
          }
        }
        return that;
      }
    });
    function compilePart(part, stringPart) {
      if (stringPart) {
        return "'" + part.split("'").join("\\'").split('\\"').join('\\\\\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + "'";
      } else {
        var first = part.charAt(0),
            rest = part.substring(1);
        if (first === "=") {
          return "+(" + rest + ")+";
        } else if (first === ":") {
          return "+$kendoHtmlEncode(" + rest + ")+";
        } else {
          return ";" + part + ";$kendoOutput+=";
        }
      }
    }
    var argumentNameRegExp = /^\w+/,
        encodeRegExp = /\$\{([^}]*)\}/g,
        escapedCurlyRegExp = /\\\}/g,
        curlyRegExp = /__CURLY__/g,
        escapedSharpRegExp = /\\#/g,
        sharpRegExp = /__SHARP__/g,
        zeros = ["", "0", "00", "000", "0000"];
    Template = {
      paramName: "data",
      useWithBlock: true,
      render: function(template, data) {
        var idx,
            length,
            html = "";
        for (idx = 0, length = data.length; idx < length; idx++) {
          html += template(data[idx]);
        }
        return html;
      },
      compile: function(template, options) {
        var settings = extend({}, this, options),
            paramName = settings.paramName,
            argumentName = paramName.match(argumentNameRegExp)[0],
            useWithBlock = settings.useWithBlock,
            functionBody = "var $kendoOutput, $kendoHtmlEncode = kendo.htmlEncode;",
            fn,
            parts,
            idx;
        if (isFunction(template)) {
          return template;
        }
        functionBody += useWithBlock ? "with(" + paramName + "){" : "";
        functionBody += "$kendoOutput=";
        parts = template.replace(escapedCurlyRegExp, "__CURLY__").replace(encodeRegExp, "#=$kendoHtmlEncode($1)#").replace(curlyRegExp, "}").replace(escapedSharpRegExp, "__SHARP__").split("#");
        for (idx = 0; idx < parts.length; idx++) {
          functionBody += compilePart(parts[idx], idx % 2 === 0);
        }
        functionBody += useWithBlock ? ";}" : ";";
        functionBody += "return $kendoOutput;";
        functionBody = functionBody.replace(sharpRegExp, "#");
        try {
          fn = new Function(argumentName, functionBody);
          fn._slotCount = Math.floor(parts.length / 2);
          return fn;
        } catch (e) {
          throw new Error(kendo.format("Invalid template:'{0}' Generated code:'{1}'", template, functionBody));
        }
      }
    };
    function pad(number, digits, end) {
      number = number + "";
      digits = digits || 2;
      end = digits - number.length;
      if (end) {
        return zeros[digits].substring(0, end) + number;
      }
      return number;
    }
    (function() {
      var escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
          gap,
          indent,
          meta = {
            "\b": "\\b",
            "\t": "\\t",
            "\n": "\\n",
            "\f": "\\f",
            "\r": "\\r",
            "\"": '\\"',
            "\\": "\\\\"
          },
          rep,
          toString = {}.toString;
      if (typeof Date.prototype.toJSON !== FUNCTION) {
        Date.prototype.toJSON = function() {
          var that = this;
          return isFinite(that.valueOf()) ? pad(that.getUTCFullYear(), 4) + "-" + pad(that.getUTCMonth() + 1) + "-" + pad(that.getUTCDate()) + "T" + pad(that.getUTCHours()) + ":" + pad(that.getUTCMinutes()) + ":" + pad(that.getUTCSeconds()) + "Z" : null;
        };
        String.prototype.toJSON = Number.prototype.toJSON = Boolean.prototype.toJSON = function() {
          return this.valueOf();
        };
      }
      function quote(string) {
        escapable.lastIndex = 0;
        return escapable.test(string) ? "\"" + string.replace(escapable, function(a) {
          var c = meta[a];
          return typeof c === STRING ? c : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
        }) + "\"" : "\"" + string + "\"";
      }
      function str(key, holder) {
        var i,
            k,
            v,
            length,
            mind = gap,
            partial,
            value = holder[key],
            type;
        if (value && typeof value === OBJECT && typeof value.toJSON === FUNCTION) {
          value = value.toJSON(key);
        }
        if (typeof rep === FUNCTION) {
          value = rep.call(holder, key, value);
        }
        type = typeof value;
        if (type === STRING) {
          return quote(value);
        } else if (type === NUMBER) {
          return isFinite(value) ? String(value) : NULL;
        } else if (type === BOOLEAN || type === NULL) {
          return String(value);
        } else if (type === OBJECT) {
          if (!value) {
            return NULL;
          }
          gap += indent;
          partial = [];
          if (toString.apply(value) === "[object Array]") {
            length = value.length;
            for (i = 0; i < length; i++) {
              partial[i] = str(i, value) || NULL;
            }
            v = partial.length === 0 ? "[]" : gap ? "[\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "]" : "[" + partial.join(",") + "]";
            gap = mind;
            return v;
          }
          if (rep && typeof rep === OBJECT) {
            length = rep.length;
            for (i = 0; i < length; i++) {
              if (typeof rep[i] === STRING) {
                k = rep[i];
                v = str(k, value);
                if (v) {
                  partial.push(quote(k) + (gap ? ": " : ":") + v);
                }
              }
            }
          } else {
            for (k in value) {
              if (Object.hasOwnProperty.call(value, k)) {
                v = str(k, value);
                if (v) {
                  partial.push(quote(k) + (gap ? ": " : ":") + v);
                }
              }
            }
          }
          v = partial.length === 0 ? "{}" : gap ? "{\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "}" : "{" + partial.join(",") + "}";
          gap = mind;
          return v;
        }
      }
      if (typeof JSON.stringify !== FUNCTION) {
        JSON.stringify = function(value, replacer, space) {
          var i;
          gap = "";
          indent = "";
          if (typeof space === NUMBER) {
            for (i = 0; i < space; i += 1) {
              indent += " ";
            }
          } else if (typeof space === STRING) {
            indent = space;
          }
          rep = replacer;
          if (replacer && typeof replacer !== FUNCTION && (typeof replacer !== OBJECT || typeof replacer.length !== NUMBER)) {
            throw new Error("JSON.stringify");
          }
          return str("", {"": value});
        };
      }
    })();
    (function() {
      var dateFormatRegExp = /dddd|ddd|dd|d|MMMM|MMM|MM|M|yyyy|yy|HH|H|hh|h|mm|m|fff|ff|f|tt|ss|s|zzz|zz|z|"[^"]*"|'[^']*'/g,
          standardFormatRegExp = /^(n|c|p|e)(\d*)$/i,
          literalRegExp = /(\\.)|(['][^']*[']?)|(["][^"]*["]?)/g,
          commaRegExp = /\,/g,
          EMPTY = "",
          POINT = ".",
          COMMA = ",",
          SHARP = "#",
          ZERO = "0",
          PLACEHOLDER = "??",
          EN = "en-US",
          objectToString = {}.toString;
      kendo.cultures["en-US"] = {
        name: EN,
        numberFormat: {
          pattern: ["-n"],
          decimals: 2,
          ",": ",",
          ".": ".",
          groupSize: [3],
          percent: {
            pattern: ["-n %", "n %"],
            decimals: 2,
            ",": ",",
            ".": ".",
            groupSize: [3],
            symbol: "%"
          },
          currency: {
            pattern: ["($n)", "$n"],
            decimals: 2,
            ",": ",",
            ".": ".",
            groupSize: [3],
            symbol: "$"
          }
        },
        calendars: {standard: {
            days: {
              names: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
              namesAbbr: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
              namesShort: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
            },
            months: {
              names: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
              namesAbbr: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
            },
            AM: ["AM", "am", "AM"],
            PM: ["PM", "pm", "PM"],
            patterns: {
              d: "M/d/yyyy",
              D: "dddd, MMMM dd, yyyy",
              F: "dddd, MMMM dd, yyyy h:mm:ss tt",
              g: "M/d/yyyy h:mm tt",
              G: "M/d/yyyy h:mm:ss tt",
              m: "MMMM dd",
              M: "MMMM dd",
              s: "yyyy'-'MM'-'ddTHH':'mm':'ss",
              t: "h:mm tt",
              T: "h:mm:ss tt",
              u: "yyyy'-'MM'-'dd HH':'mm':'ss'Z'",
              y: "MMMM, yyyy",
              Y: "MMMM, yyyy"
            },
            "/": "/",
            ":": ":",
            firstDay: 0,
            twoDigitYearMax: 2029
          }}
      };
      function findCulture(culture) {
        if (culture) {
          if (culture.numberFormat) {
            return culture;
          }
          if (typeof culture === STRING) {
            var cultures = kendo.cultures;
            return cultures[culture] || cultures[culture.split("-")[0]] || null;
          }
          return null;
        }
        return null;
      }
      function getCulture(culture) {
        if (culture) {
          culture = findCulture(culture);
        }
        return culture || kendo.cultures.current;
      }
      function expandNumberFormat(numberFormat) {
        numberFormat.groupSizes = numberFormat.groupSize;
        numberFormat.percent.groupSizes = numberFormat.percent.groupSize;
        numberFormat.currency.groupSizes = numberFormat.currency.groupSize;
      }
      kendo.culture = function(cultureName) {
        var cultures = kendo.cultures,
            culture;
        if (cultureName !== undefined) {
          culture = findCulture(cultureName) || cultures[EN];
          culture.calendar = culture.calendars.standard;
          cultures.current = culture;
          if (globalize && !globalize.load) {
            expandNumberFormat(culture.numberFormat);
          }
        } else {
          return cultures.current;
        }
      };
      kendo.findCulture = findCulture;
      kendo.getCulture = getCulture;
      kendo.culture(EN);
      function formatDate(date, format, culture) {
        culture = getCulture(culture);
        var calendar = culture.calendars.standard,
            days = calendar.days,
            months = calendar.months;
        format = calendar.patterns[format] || format;
        return format.replace(dateFormatRegExp, function(match) {
          var minutes;
          var result;
          var sign;
          if (match === "d") {
            result = date.getDate();
          } else if (match === "dd") {
            result = pad(date.getDate());
          } else if (match === "ddd") {
            result = days.namesAbbr[date.getDay()];
          } else if (match === "dddd") {
            result = days.names[date.getDay()];
          } else if (match === "M") {
            result = date.getMonth() + 1;
          } else if (match === "MM") {
            result = pad(date.getMonth() + 1);
          } else if (match === "MMM") {
            result = months.namesAbbr[date.getMonth()];
          } else if (match === "MMMM") {
            result = months.names[date.getMonth()];
          } else if (match === "yy") {
            result = pad(date.getFullYear() % 100);
          } else if (match === "yyyy") {
            result = pad(date.getFullYear(), 4);
          } else if (match === "h") {
            result = date.getHours() % 12 || 12;
          } else if (match === "hh") {
            result = pad(date.getHours() % 12 || 12);
          } else if (match === "H") {
            result = date.getHours();
          } else if (match === "HH") {
            result = pad(date.getHours());
          } else if (match === "m") {
            result = date.getMinutes();
          } else if (match === "mm") {
            result = pad(date.getMinutes());
          } else if (match === "s") {
            result = date.getSeconds();
          } else if (match === "ss") {
            result = pad(date.getSeconds());
          } else if (match === "f") {
            result = math.floor(date.getMilliseconds() / 100);
          } else if (match === "ff") {
            result = date.getMilliseconds();
            if (result > 99) {
              result = math.floor(result / 10);
            }
            result = pad(result);
          } else if (match === "fff") {
            result = pad(date.getMilliseconds(), 3);
          } else if (match === "tt") {
            result = date.getHours() < 12 ? calendar.AM[0] : calendar.PM[0];
          } else if (match === "zzz") {
            minutes = date.getTimezoneOffset();
            sign = minutes < 0;
            result = math.abs(minutes / 60).toString().split(".")[0];
            minutes = math.abs(minutes) - (result * 60);
            result = (sign ? "+" : "-") + pad(result);
            result += ":" + pad(minutes);
          } else if (match === "zz" || match === "z") {
            result = date.getTimezoneOffset() / 60;
            sign = result < 0;
            result = math.abs(result).toString().split(".")[0];
            result = (sign ? "+" : "-") + (match === "zz" ? pad(result) : result);
          }
          return result !== undefined ? result : match.slice(1, match.length - 1);
        });
      }
      function formatNumber(number, format, culture) {
        culture = getCulture(culture);
        var numberFormat = culture.numberFormat,
            groupSize = numberFormat.groupSize[0],
            groupSeparator = numberFormat[COMMA],
            decimal = numberFormat[POINT],
            precision = numberFormat.decimals,
            pattern = numberFormat.pattern[0],
            literals = [],
            symbol,
            isCurrency,
            isPercent,
            customPrecision,
            formatAndPrecision,
            negative = number < 0,
            integer,
            fraction,
            integerLength,
            fractionLength,
            replacement = EMPTY,
            value = EMPTY,
            idx,
            length,
            ch,
            hasGroup,
            hasNegativeFormat,
            decimalIndex,
            sharpIndex,
            zeroIndex,
            hasZero,
            hasSharp,
            percentIndex,
            currencyIndex,
            startZeroIndex,
            start = -1,
            end;
        if (number === undefined) {
          return EMPTY;
        }
        if (!isFinite(number)) {
          return number;
        }
        if (!format) {
          return culture.name.length ? number.toLocaleString() : number.toString();
        }
        formatAndPrecision = standardFormatRegExp.exec(format);
        if (formatAndPrecision) {
          format = formatAndPrecision[1].toLowerCase();
          isCurrency = format === "c";
          isPercent = format === "p";
          if (isCurrency || isPercent) {
            numberFormat = isCurrency ? numberFormat.currency : numberFormat.percent;
            groupSize = numberFormat.groupSize[0];
            groupSeparator = numberFormat[COMMA];
            decimal = numberFormat[POINT];
            precision = numberFormat.decimals;
            symbol = numberFormat.symbol;
            pattern = numberFormat.pattern[negative ? 0 : 1];
          }
          customPrecision = formatAndPrecision[2];
          if (customPrecision) {
            precision = +customPrecision;
          }
          if (format === "e") {
            return customPrecision ? number.toExponential(precision) : number.toExponential();
          }
          if (isPercent) {
            number *= 100;
          }
          number = round(number, precision);
          negative = number < 0;
          number = number.split(POINT);
          integer = number[0];
          fraction = number[1];
          if (negative) {
            integer = integer.substring(1);
          }
          value = integer;
          integerLength = integer.length;
          if (integerLength >= groupSize) {
            value = EMPTY;
            for (idx = 0; idx < integerLength; idx++) {
              if (idx > 0 && (integerLength - idx) % groupSize === 0) {
                value += groupSeparator;
              }
              value += integer.charAt(idx);
            }
          }
          if (fraction) {
            value += decimal + fraction;
          }
          if (format === "n" && !negative) {
            return value;
          }
          number = EMPTY;
          for (idx = 0, length = pattern.length; idx < length; idx++) {
            ch = pattern.charAt(idx);
            if (ch === "n") {
              number += value;
            } else if (ch === "$" || ch === "%") {
              number += symbol;
            } else {
              number += ch;
            }
          }
          return number;
        }
        if (negative) {
          number = -number;
        }
        if (format.indexOf("'") > -1 || format.indexOf("\"") > -1 || format.indexOf("\\") > -1) {
          format = format.replace(literalRegExp, function(match) {
            var quoteChar = match.charAt(0).replace("\\", ""),
                literal = match.slice(1).replace(quoteChar, "");
            literals.push(literal);
            return PLACEHOLDER;
          });
        }
        format = format.split(";");
        if (negative && format[1]) {
          format = format[1];
          hasNegativeFormat = true;
        } else if (number === 0) {
          format = format[2] || format[0];
          if (format.indexOf(SHARP) == -1 && format.indexOf(ZERO) == -1) {
            return format;
          }
        } else {
          format = format[0];
        }
        percentIndex = format.indexOf("%");
        currencyIndex = format.indexOf("$");
        isPercent = percentIndex != -1;
        isCurrency = currencyIndex != -1;
        if (isPercent) {
          number *= 100;
        }
        if (isCurrency && format[currencyIndex - 1] === "\\") {
          format = format.split("\\").join("");
          isCurrency = false;
        }
        if (isCurrency || isPercent) {
          numberFormat = isCurrency ? numberFormat.currency : numberFormat.percent;
          groupSize = numberFormat.groupSize[0];
          groupSeparator = numberFormat[COMMA];
          decimal = numberFormat[POINT];
          precision = numberFormat.decimals;
          symbol = numberFormat.symbol;
        }
        hasGroup = format.indexOf(COMMA) > -1;
        if (hasGroup) {
          format = format.replace(commaRegExp, EMPTY);
        }
        decimalIndex = format.indexOf(POINT);
        length = format.length;
        if (decimalIndex != -1) {
          fraction = number.toString().split("e");
          if (fraction[1]) {
            fraction = round(number, Math.abs(fraction[1]));
          } else {
            fraction = fraction[0];
          }
          fraction = fraction.split(POINT)[1] || EMPTY;
          zeroIndex = format.lastIndexOf(ZERO) - decimalIndex;
          sharpIndex = format.lastIndexOf(SHARP) - decimalIndex;
          hasZero = zeroIndex > -1;
          hasSharp = sharpIndex > -1;
          idx = fraction.length;
          if (!hasZero && !hasSharp) {
            format = format.substring(0, decimalIndex) + format.substring(decimalIndex + 1);
            length = format.length;
            decimalIndex = -1;
            idx = 0;
          }
          if (hasZero && zeroIndex > sharpIndex) {
            idx = zeroIndex;
          } else if (sharpIndex > zeroIndex) {
            if (hasSharp && idx > sharpIndex) {
              idx = sharpIndex;
            } else if (hasZero && idx < zeroIndex) {
              idx = zeroIndex;
            }
          }
          if (idx > -1) {
            number = round(number, idx);
          }
        } else {
          number = round(number);
        }
        sharpIndex = format.indexOf(SHARP);
        startZeroIndex = zeroIndex = format.indexOf(ZERO);
        if (sharpIndex == -1 && zeroIndex != -1) {
          start = zeroIndex;
        } else if (sharpIndex != -1 && zeroIndex == -1) {
          start = sharpIndex;
        } else {
          start = sharpIndex > zeroIndex ? zeroIndex : sharpIndex;
        }
        sharpIndex = format.lastIndexOf(SHARP);
        zeroIndex = format.lastIndexOf(ZERO);
        if (sharpIndex == -1 && zeroIndex != -1) {
          end = zeroIndex;
        } else if (sharpIndex != -1 && zeroIndex == -1) {
          end = sharpIndex;
        } else {
          end = sharpIndex > zeroIndex ? sharpIndex : zeroIndex;
        }
        if (start == length) {
          end = start;
        }
        if (start != -1) {
          value = number.toString().split(POINT);
          integer = value[0];
          fraction = value[1] || EMPTY;
          integerLength = integer.length;
          fractionLength = fraction.length;
          if (negative && (number * -1) >= 0) {
            negative = false;
          }
          if (hasGroup) {
            if (integerLength === groupSize && integerLength < decimalIndex - startZeroIndex) {
              integer = groupSeparator + integer;
            } else if (integerLength > groupSize) {
              value = EMPTY;
              for (idx = 0; idx < integerLength; idx++) {
                if (idx > 0 && (integerLength - idx) % groupSize === 0) {
                  value += groupSeparator;
                }
                value += integer.charAt(idx);
              }
              integer = value;
            }
          }
          number = format.substring(0, start);
          if (negative && !hasNegativeFormat) {
            number += "-";
          }
          for (idx = start; idx < length; idx++) {
            ch = format.charAt(idx);
            if (decimalIndex == -1) {
              if (end - idx < integerLength) {
                number += integer;
                break;
              }
            } else {
              if (zeroIndex != -1 && zeroIndex < idx) {
                replacement = EMPTY;
              }
              if ((decimalIndex - idx) <= integerLength && decimalIndex - idx > -1) {
                number += integer;
                idx = decimalIndex;
              }
              if (decimalIndex === idx) {
                number += (fraction ? decimal : EMPTY) + fraction;
                idx += end - decimalIndex + 1;
                continue;
              }
            }
            if (ch === ZERO) {
              number += ch;
              replacement = ch;
            } else if (ch === SHARP) {
              number += replacement;
            }
          }
          if (end >= start) {
            number += format.substring(end + 1);
          }
          if (isCurrency || isPercent) {
            value = EMPTY;
            for (idx = 0, length = number.length; idx < length; idx++) {
              ch = number.charAt(idx);
              value += (ch === "$" || ch === "%") ? symbol : ch;
            }
            number = value;
          }
          length = literals.length;
          if (length) {
            for (idx = 0; idx < length; idx++) {
              number = number.replace(PLACEHOLDER, literals[idx]);
            }
          }
        }
        return number;
      }
      var round = function(value, precision) {
        precision = precision || 0;
        value = value.toString().split('e');
        value = Math.round(+(value[0] + 'e' + (value[1] ? (+value[1] + precision) : precision)));
        value = value.toString().split('e');
        value = +(value[0] + 'e' + (value[1] ? (+value[1] - precision) : -precision));
        return value.toFixed(precision);
      };
      var toString = function(value, fmt, culture) {
        if (fmt) {
          if (objectToString.call(value) === "[object Date]") {
            return formatDate(value, fmt, culture);
          } else if (typeof value === NUMBER) {
            return formatNumber(value, fmt, culture);
          }
        }
        return value !== undefined ? value : "";
      };
      if (globalize && !globalize.load) {
        toString = function(value, format, culture) {
          if ($.isPlainObject(culture)) {
            culture = culture.name;
          }
          return globalize.format(value, format, culture);
        };
      }
      kendo.format = function(fmt) {
        var values = arguments;
        return fmt.replace(formatRegExp, function(match, index, placeholderFormat) {
          var value = values[parseInt(index, 10) + 1];
          return toString(value, placeholderFormat ? placeholderFormat.substring(1) : "");
        });
      };
      kendo._extractFormat = function(format) {
        if (format.slice(0, 3) === "{0:") {
          format = format.slice(3, format.length - 1);
        }
        return format;
      };
      kendo._activeElement = function() {
        try {
          return document.activeElement;
        } catch (e) {
          return document.documentElement.activeElement;
        }
      };
      kendo._round = round;
      kendo.toString = toString;
    })();
    (function() {
      var nonBreakingSpaceRegExp = /\u00A0/g,
          exponentRegExp = /[eE][\-+]?[0-9]+/,
          shortTimeZoneRegExp = /[+|\-]\d{1,2}/,
          longTimeZoneRegExp = /[+|\-]\d{1,2}:?\d{2}/,
          dateRegExp = /^\/Date\((.*?)\)\/$/,
          offsetRegExp = /[+-]\d*/,
          formatsSequence = ["G", "g", "d", "F", "D", "y", "m", "T", "t"],
          numberRegExp = {
            2: /^\d{1,2}/,
            3: /^\d{1,3}/,
            4: /^\d{4}/
          },
          objectToString = {}.toString;
      function outOfRange(value, start, end) {
        return !(value >= start && value <= end);
      }
      function designatorPredicate(designator) {
        return designator.charAt(0);
      }
      function mapDesignators(designators) {
        return $.map(designators, designatorPredicate);
      }
      function adjustDST(date, hours) {
        if (!hours && date.getHours() === 23) {
          date.setHours(date.getHours() + 2);
        }
      }
      function lowerArray(data) {
        var idx = 0,
            length = data.length,
            array = [];
        for (; idx < length; idx++) {
          array[idx] = (data[idx] + "").toLowerCase();
        }
        return array;
      }
      function lowerLocalInfo(localInfo) {
        var newLocalInfo = {},
            property;
        for (property in localInfo) {
          newLocalInfo[property] = lowerArray(localInfo[property]);
        }
        return newLocalInfo;
      }
      function parseExact(value, format, culture) {
        if (!value) {
          return null;
        }
        var lookAhead = function(match) {
          var i = 0;
          while (format[idx] === match) {
            i++;
            idx++;
          }
          if (i > 0) {
            idx -= 1;
          }
          return i;
        },
            getNumber = function(size) {
              var rg = numberRegExp[size] || new RegExp('^\\d{1,' + size + '}'),
                  match = value.substr(valueIdx, size).match(rg);
              if (match) {
                match = match[0];
                valueIdx += match.length;
                return parseInt(match, 10);
              }
              return null;
            },
            getIndexByName = function(names, lower) {
              var i = 0,
                  length = names.length,
                  name,
                  nameLength,
                  matchLength = 0,
                  matchIdx = 0,
                  subValue;
              for (; i < length; i++) {
                name = names[i];
                nameLength = name.length;
                subValue = value.substr(valueIdx, nameLength);
                if (lower) {
                  subValue = subValue.toLowerCase();
                }
                if (subValue == name && nameLength > matchLength) {
                  matchLength = nameLength;
                  matchIdx = i;
                }
              }
              if (matchLength) {
                valueIdx += matchLength;
                return matchIdx + 1;
              }
              return null;
            },
            checkLiteral = function() {
              var result = false;
              if (value.charAt(valueIdx) === format[idx]) {
                valueIdx++;
                result = true;
              }
              return result;
            },
            calendar = culture.calendars.standard,
            year = null,
            month = null,
            day = null,
            hours = null,
            minutes = null,
            seconds = null,
            milliseconds = null,
            idx = 0,
            valueIdx = 0,
            literal = false,
            date = new Date(),
            twoDigitYearMax = calendar.twoDigitYearMax || 2029,
            defaultYear = date.getFullYear(),
            ch,
            count,
            length,
            pattern,
            pmHour,
            UTC,
            matches,
            amDesignators,
            pmDesignators,
            hoursOffset,
            minutesOffset,
            hasTime,
            match;
        if (!format) {
          format = "d";
        }
        pattern = calendar.patterns[format];
        if (pattern) {
          format = pattern;
        }
        format = format.split("");
        length = format.length;
        for (; idx < length; idx++) {
          ch = format[idx];
          if (literal) {
            if (ch === "'") {
              literal = false;
            } else {
              checkLiteral();
            }
          } else {
            if (ch === "d") {
              count = lookAhead("d");
              if (!calendar._lowerDays) {
                calendar._lowerDays = lowerLocalInfo(calendar.days);
              }
              if (day !== null && count > 2) {
                continue;
              }
              day = count < 3 ? getNumber(2) : getIndexByName(calendar._lowerDays[count == 3 ? "namesAbbr" : "names"], true);
              if (day === null || outOfRange(day, 1, 31)) {
                return null;
              }
            } else if (ch === "M") {
              count = lookAhead("M");
              if (!calendar._lowerMonths) {
                calendar._lowerMonths = lowerLocalInfo(calendar.months);
              }
              month = count < 3 ? getNumber(2) : getIndexByName(calendar._lowerMonths[count == 3 ? 'namesAbbr' : 'names'], true);
              if (month === null || outOfRange(month, 1, 12)) {
                return null;
              }
              month -= 1;
            } else if (ch === "y") {
              count = lookAhead("y");
              year = getNumber(count);
              if (year === null) {
                return null;
              }
              if (count == 2) {
                if (typeof twoDigitYearMax === "string") {
                  twoDigitYearMax = defaultYear + parseInt(twoDigitYearMax, 10);
                }
                year = (defaultYear - defaultYear % 100) + year;
                if (year > twoDigitYearMax) {
                  year -= 100;
                }
              }
            } else if (ch === "h") {
              lookAhead("h");
              hours = getNumber(2);
              if (hours == 12) {
                hours = 0;
              }
              if (hours === null || outOfRange(hours, 0, 11)) {
                return null;
              }
            } else if (ch === "H") {
              lookAhead("H");
              hours = getNumber(2);
              if (hours === null || outOfRange(hours, 0, 23)) {
                return null;
              }
            } else if (ch === "m") {
              lookAhead("m");
              minutes = getNumber(2);
              if (minutes === null || outOfRange(minutes, 0, 59)) {
                return null;
              }
            } else if (ch === "s") {
              lookAhead("s");
              seconds = getNumber(2);
              if (seconds === null || outOfRange(seconds, 0, 59)) {
                return null;
              }
            } else if (ch === "f") {
              count = lookAhead("f");
              match = value.substr(valueIdx, count).match(numberRegExp[3]);
              milliseconds = getNumber(count);
              if (milliseconds !== null) {
                match = match[0].length;
                if (match < 3) {
                  milliseconds *= Math.pow(10, (3 - match));
                }
                if (count > 3) {
                  milliseconds = parseInt(milliseconds.toString().substring(0, 3), 10);
                }
              }
              if (milliseconds === null || outOfRange(milliseconds, 0, 999)) {
                return null;
              }
            } else if (ch === "t") {
              count = lookAhead("t");
              amDesignators = calendar.AM;
              pmDesignators = calendar.PM;
              if (count === 1) {
                amDesignators = mapDesignators(amDesignators);
                pmDesignators = mapDesignators(pmDesignators);
              }
              pmHour = getIndexByName(pmDesignators);
              if (!pmHour && !getIndexByName(amDesignators)) {
                return null;
              }
            } else if (ch === "z") {
              UTC = true;
              count = lookAhead("z");
              if (value.substr(valueIdx, 1) === "Z") {
                checkLiteral();
                continue;
              }
              matches = value.substr(valueIdx, 6).match(count > 2 ? longTimeZoneRegExp : shortTimeZoneRegExp);
              if (!matches) {
                return null;
              }
              matches = matches[0].split(":");
              hoursOffset = matches[0];
              minutesOffset = matches[1];
              if (!minutesOffset && hoursOffset.length > 3) {
                valueIdx = hoursOffset.length - 2;
                minutesOffset = hoursOffset.substring(valueIdx);
                hoursOffset = hoursOffset.substring(0, valueIdx);
              }
              hoursOffset = parseInt(hoursOffset, 10);
              if (outOfRange(hoursOffset, -12, 13)) {
                return null;
              }
              if (count > 2) {
                minutesOffset = parseInt(minutesOffset, 10);
                if (isNaN(minutesOffset) || outOfRange(minutesOffset, 0, 59)) {
                  return null;
                }
              }
            } else if (ch === "'") {
              literal = true;
              checkLiteral();
            } else if (!checkLiteral()) {
              return null;
            }
          }
        }
        hasTime = hours !== null || minutes !== null || seconds || null;
        if (year === null && month === null && day === null && hasTime) {
          year = defaultYear;
          month = date.getMonth();
          day = date.getDate();
        } else {
          if (year === null) {
            year = defaultYear;
          }
          if (day === null) {
            day = 1;
          }
        }
        if (pmHour && hours < 12) {
          hours += 12;
        }
        if (UTC) {
          if (hoursOffset) {
            hours += -hoursOffset;
          }
          if (minutesOffset) {
            minutes += -minutesOffset;
          }
          value = new Date(Date.UTC(year, month, day, hours, minutes, seconds, milliseconds));
        } else {
          value = new Date(year, month, day, hours, minutes, seconds, milliseconds);
          adjustDST(value, hours);
        }
        if (year < 100) {
          value.setFullYear(year);
        }
        if (value.getDate() !== day && UTC === undefined) {
          return null;
        }
        return value;
      }
      function parseMicrosoftFormatOffset(offset) {
        var sign = offset.substr(0, 1) === "-" ? -1 : 1;
        offset = offset.substring(1);
        offset = (parseInt(offset.substr(0, 2), 10) * 60) + parseInt(offset.substring(2), 10);
        return sign * offset;
      }
      kendo.parseDate = function(value, formats, culture) {
        if (objectToString.call(value) === "[object Date]") {
          return value;
        }
        var idx = 0;
        var date = null;
        var length,
            patterns;
        var tzoffset;
        var sign;
        if (value && value.indexOf("/D") === 0) {
          date = dateRegExp.exec(value);
          if (date) {
            date = date[1];
            tzoffset = offsetRegExp.exec(date.substring(1));
            date = new Date(parseInt(date, 10));
            if (tzoffset) {
              tzoffset = parseMicrosoftFormatOffset(tzoffset[0]);
              date = kendo.timezone.apply(date, 0);
              date = kendo.timezone.convert(date, 0, -1 * tzoffset);
            }
            return date;
          }
        }
        culture = kendo.getCulture(culture);
        if (!formats) {
          formats = [];
          patterns = culture.calendar.patterns;
          length = formatsSequence.length;
          for (; idx < length; idx++) {
            formats[idx] = patterns[formatsSequence[idx]];
          }
          idx = 0;
          formats = ["yyyy/MM/dd HH:mm:ss", "yyyy/MM/dd HH:mm", "yyyy/MM/dd", "ddd MMM dd yyyy HH:mm:ss", "yyyy-MM-ddTHH:mm:ss.fffffffzzz", "yyyy-MM-ddTHH:mm:ss.fffzzz", "yyyy-MM-ddTHH:mm:sszzz", "yyyy-MM-ddTHH:mm:ss.fffffff", "yyyy-MM-ddTHH:mm:ss.fff", "yyyy-MM-ddTHH:mmzzz", "yyyy-MM-ddTHH:mmzz", "yyyy-MM-ddTHH:mm:ss", "yyyy-MM-ddTHH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd", "HH:mm:ss", "HH:mm"].concat(formats);
        }
        formats = isArray(formats) ? formats : [formats];
        length = formats.length;
        for (; idx < length; idx++) {
          date = parseExact(value, formats[idx], culture);
          if (date) {
            return date;
          }
        }
        return date;
      };
      kendo.parseInt = function(value, culture) {
        var result = kendo.parseFloat(value, culture);
        if (result) {
          result = result | 0;
        }
        return result;
      };
      kendo.parseFloat = function(value, culture, format) {
        if (!value && value !== 0) {
          return null;
        }
        if (typeof value === NUMBER) {
          return value;
        }
        value = value.toString();
        culture = kendo.getCulture(culture);
        var number = culture.numberFormat,
            percent = number.percent,
            currency = number.currency,
            symbol = currency.symbol,
            percentSymbol = percent.symbol,
            negative = value.indexOf("-"),
            parts,
            isPercent;
        if (exponentRegExp.test(value)) {
          value = parseFloat(value.replace(number["."], "."));
          if (isNaN(value)) {
            value = null;
          }
          return value;
        }
        if (negative > 0) {
          return null;
        } else {
          negative = negative > -1;
        }
        if (value.indexOf(symbol) > -1 || (format && format.toLowerCase().indexOf("c") > -1)) {
          number = currency;
          parts = number.pattern[0].replace("$", symbol).split("n");
          if (value.indexOf(parts[0]) > -1 && value.indexOf(parts[1]) > -1) {
            value = value.replace(parts[0], "").replace(parts[1], "");
            negative = true;
          }
        } else if (value.indexOf(percentSymbol) > -1) {
          isPercent = true;
          number = percent;
          symbol = percentSymbol;
        }
        value = value.replace("-", "").replace(symbol, "").replace(nonBreakingSpaceRegExp, " ").split(number[","].replace(nonBreakingSpaceRegExp, " ")).join("").replace(number["."], ".");
        value = parseFloat(value);
        if (isNaN(value)) {
          value = null;
        } else if (negative) {
          value *= -1;
        }
        if (value && isPercent) {
          value /= 100;
        }
        return value;
      };
      if (globalize && !globalize.load) {
        kendo.parseDate = function(value, format, culture) {
          if (objectToString.call(value) === "[object Date]") {
            return value;
          }
          return globalize.parseDate(value, format, culture);
        };
        kendo.parseFloat = function(value, culture) {
          if (typeof value === NUMBER) {
            return value;
          }
          if (value === undefined || value === null) {
            return null;
          }
          if ($.isPlainObject(culture)) {
            culture = culture.name;
          }
          value = globalize.parseFloat(value, culture);
          return isNaN(value) ? null : value;
        };
      }
    })();
    function getShadows(element) {
      var shadow = element.css(kendo.support.transitions.css + "box-shadow") || element.css("box-shadow"),
          radius = shadow ? shadow.match(boxShadowRegExp) || [0, 0, 0, 0, 0] : [0, 0, 0, 0, 0],
          blur = math.max((+radius[3]), +(radius[4] || 0));
      return {
        left: (-radius[1]) + blur,
        right: (+radius[1]) + blur,
        bottom: (+radius[2]) + blur
      };
    }
    function wrap(element, autosize) {
      var browser = support.browser,
          percentage,
          isRtl = element.css("direction") == "rtl";
      if (!element.parent().hasClass("k-animation-container")) {
        var shadows = getShadows(element),
            width = element[0].style.width,
            height = element[0].style.height,
            percentWidth = percentRegExp.test(width),
            percentHeight = percentRegExp.test(height);
        if (browser.opera) {
          shadows.left = shadows.right = shadows.bottom = 5;
        }
        percentage = percentWidth || percentHeight;
        if (!percentWidth && (!autosize || (autosize && width))) {
          width = element.outerWidth();
        }
        if (!percentHeight && (!autosize || (autosize && height))) {
          height = element.outerHeight();
        }
        element.wrap($("<div/>").addClass("k-animation-container").css({
          width: width,
          height: height,
          marginLeft: shadows.left * (isRtl ? 1 : -1),
          paddingLeft: shadows.left,
          paddingRight: shadows.right,
          paddingBottom: shadows.bottom
        }));
        if (percentage) {
          element.css({
            width: "100%",
            height: "100%",
            boxSizing: "border-box",
            mozBoxSizing: "border-box",
            webkitBoxSizing: "border-box"
          });
        }
      } else {
        var wrapper = element.parent(".k-animation-container"),
            wrapperStyle = wrapper[0].style;
        if (wrapper.is(":hidden")) {
          wrapper.show();
        }
        percentage = percentRegExp.test(wrapperStyle.width) || percentRegExp.test(wrapperStyle.height);
        if (!percentage) {
          wrapper.css({
            width: element.outerWidth(),
            height: element.outerHeight(),
            boxSizing: "content-box",
            mozBoxSizing: "content-box",
            webkitBoxSizing: "content-box"
          });
        }
      }
      if (browser.msie && math.floor(browser.version) <= 7) {
        element.css({zoom: 1});
        element.children(".k-menu").width(element.width());
      }
      return element.parent();
    }
    function deepExtend(destination) {
      var i = 1,
          length = arguments.length;
      for (i = 1; i < length; i++) {
        deepExtendOne(destination, arguments[i]);
      }
      return destination;
    }
    function deepExtendOne(destination, source) {
      var ObservableArray = kendo.data.ObservableArray,
          LazyObservableArray = kendo.data.LazyObservableArray,
          DataSource = kendo.data.DataSource,
          HierarchicalDataSource = kendo.data.HierarchicalDataSource,
          property,
          propValue,
          propType,
          propInit,
          destProp;
      for (property in source) {
        propValue = source[property];
        propType = typeof propValue;
        if (propType === OBJECT && propValue !== null) {
          propInit = propValue.constructor;
        } else {
          propInit = null;
        }
        if (propInit && propInit !== Array && propInit !== ObservableArray && propInit !== LazyObservableArray && propInit !== DataSource && propInit !== HierarchicalDataSource) {
          if (propValue instanceof Date) {
            destination[property] = new Date(propValue.getTime());
          } else if (isFunction(propValue.clone)) {
            destination[property] = propValue.clone();
          } else {
            destProp = destination[property];
            if (typeof(destProp) === OBJECT) {
              destination[property] = destProp || {};
            } else {
              destination[property] = {};
            }
            deepExtendOne(destination[property], propValue);
          }
        } else if (propType !== UNDEFINED) {
          destination[property] = propValue;
        }
      }
      return destination;
    }
    function testRx(agent, rxs, dflt) {
      for (var rx in rxs) {
        if (rxs.hasOwnProperty(rx) && rxs[rx].test(agent)) {
          return rx;
        }
      }
      return dflt !== undefined ? dflt : agent;
    }
    function toHyphens(str) {
      return str.replace(/([a-z][A-Z])/g, function(g) {
        return g.charAt(0) + '-' + g.charAt(1).toLowerCase();
      });
    }
    function toCamelCase(str) {
      return str.replace(/\-(\w)/g, function(strMatch, g1) {
        return g1.toUpperCase();
      });
    }
    function getComputedStyles(element, properties) {
      var styles = {},
          computedStyle;
      if (document.defaultView && document.defaultView.getComputedStyle) {
        computedStyle = document.defaultView.getComputedStyle(element, "");
        if (properties) {
          $.each(properties, function(idx, value) {
            styles[value] = computedStyle.getPropertyValue(value);
          });
        }
      } else {
        computedStyle = element.currentStyle;
        if (properties) {
          $.each(properties, function(idx, value) {
            styles[value] = computedStyle[toCamelCase(value)];
          });
        }
      }
      if (!kendo.size(styles)) {
        styles = computedStyle;
      }
      return styles;
    }
    function isScrollable(element) {
      var overflow = getComputedStyles(element, ["overflow"]).overflow;
      return overflow == "auto" || overflow == "scroll";
    }
    (function() {
      support._scrollbar = undefined;
      support.scrollbar = function(refresh) {
        if (!isNaN(support._scrollbar) && !refresh) {
          return support._scrollbar;
        } else {
          var div = document.createElement("div"),
              result;
          div.style.cssText = "overflow:scroll;overflow-x:hidden;zoom:1;clear:both;display:block";
          div.innerHTML = "&nbsp;";
          document.body.appendChild(div);
          support._scrollbar = result = div.offsetWidth - div.scrollWidth;
          document.body.removeChild(div);
          return result;
        }
      };
      support.isRtl = function(element) {
        return $(element).closest(".k-rtl").length > 0;
      };
      var table = document.createElement("table");
      try {
        table.innerHTML = "<tr><td></td></tr>";
        support.tbodyInnerHtml = true;
      } catch (e) {
        support.tbodyInnerHtml = false;
      }
      support.touch = "ontouchstart" in window;
      support.msPointers = window.MSPointerEvent;
      support.pointers = window.PointerEvent;
      var transitions = support.transitions = false,
          transforms = support.transforms = false,
          elementProto = "HTMLElement" in window ? HTMLElement.prototype : [];
      support.hasHW3D = ("WebKitCSSMatrix" in window && "m11" in new window.WebKitCSSMatrix()) || "MozPerspective" in document.documentElement.style || "msPerspective" in document.documentElement.style;
      each(["Moz", "webkit", "O", "ms"], function() {
        var prefix = this.toString(),
            hasTransitions = typeof table.style[prefix + "Transition"] === STRING;
        if (hasTransitions || typeof table.style[prefix + "Transform"] === STRING) {
          var lowPrefix = prefix.toLowerCase();
          transforms = {
            css: (lowPrefix != "ms") ? "-" + lowPrefix + "-" : "",
            prefix: prefix,
            event: (lowPrefix === "o" || lowPrefix === "webkit") ? lowPrefix : ""
          };
          if (hasTransitions) {
            transitions = transforms;
            transitions.event = transitions.event ? transitions.event + "TransitionEnd" : "transitionend";
          }
          return false;
        }
      });
      table = null;
      support.transforms = transforms;
      support.transitions = transitions;
      support.devicePixelRatio = window.devicePixelRatio === undefined ? 1 : window.devicePixelRatio;
      try {
        support.screenWidth = window.outerWidth || window.screen ? window.screen.availWidth : window.innerWidth;
        support.screenHeight = window.outerHeight || window.screen ? window.screen.availHeight : window.innerHeight;
      } catch (e) {
        support.screenWidth = window.screen.availWidth;
        support.screenHeight = window.screen.availHeight;
      }
      support.detectOS = function(ua) {
        var os = false,
            minorVersion,
            match = [],
            notAndroidPhone = !/mobile safari/i.test(ua),
            agentRxs = {
              wp: /(Windows Phone(?: OS)?)\s(\d+)\.(\d+(\.\d+)?)/,
              fire: /(Silk)\/(\d+)\.(\d+(\.\d+)?)/,
              android: /(Android|Android.*(?:Opera|Firefox).*?\/)\s*(\d+)\.(\d+(\.\d+)?)/,
              iphone: /(iPhone|iPod).*OS\s+(\d+)[\._]([\d\._]+)/,
              ipad: /(iPad).*OS\s+(\d+)[\._]([\d_]+)/,
              meego: /(MeeGo).+NokiaBrowser\/(\d+)\.([\d\._]+)/,
              webos: /(webOS)\/(\d+)\.(\d+(\.\d+)?)/,
              blackberry: /(BlackBerry|BB10).*?Version\/(\d+)\.(\d+(\.\d+)?)/,
              playbook: /(PlayBook).*?Tablet\s*OS\s*(\d+)\.(\d+(\.\d+)?)/,
              windows: /(MSIE)\s+(\d+)\.(\d+(\.\d+)?)/,
              tizen: /(tizen).*?Version\/(\d+)\.(\d+(\.\d+)?)/i,
              sailfish: /(sailfish).*rv:(\d+)\.(\d+(\.\d+)?).*firefox/i,
              ffos: /(Mobile).*rv:(\d+)\.(\d+(\.\d+)?).*Firefox/
            },
            osRxs = {
              ios: /^i(phone|pad|pod)$/i,
              android: /^android|fire$/i,
              blackberry: /^blackberry|playbook/i,
              windows: /windows/,
              wp: /wp/,
              flat: /sailfish|ffos|tizen/i,
              meego: /meego/
            },
            formFactorRxs = {tablet: /playbook|ipad|fire/i},
            browserRxs = {
              omini: /Opera\sMini/i,
              omobile: /Opera\sMobi/i,
              firefox: /Firefox|Fennec/i,
              mobilesafari: /version\/.*safari/i,
              ie: /MSIE|Windows\sPhone/i,
              chrome: /chrome|crios/i,
              webkit: /webkit/i
            };
        for (var agent in agentRxs) {
          if (agentRxs.hasOwnProperty(agent)) {
            match = ua.match(agentRxs[agent]);
            if (match) {
              if (agent == "windows" && "plugins" in navigator) {
                return false;
              }
              os = {};
              os.device = agent;
              os.tablet = testRx(agent, formFactorRxs, false);
              os.browser = testRx(ua, browserRxs, "default");
              os.name = testRx(agent, osRxs);
              os[os.name] = true;
              os.majorVersion = match[2];
              os.minorVersion = match[3].replace("_", ".");
              minorVersion = os.minorVersion.replace(".", "").substr(0, 2);
              os.flatVersion = os.majorVersion + minorVersion + (new Array(3 - (minorVersion.length < 3 ? minorVersion.length : 2)).join("0"));
              os.cordova = typeof window.PhoneGap !== UNDEFINED || typeof window.cordova !== UNDEFINED;
              os.appMode = window.navigator.standalone || (/file|local|wmapp/).test(window.location.protocol) || os.cordova;
              if (os.android && (support.devicePixelRatio < 1.5 && os.flatVersion < 400 || notAndroidPhone) && (support.screenWidth > 800 || support.screenHeight > 800)) {
                os.tablet = agent;
              }
              break;
            }
          }
        }
        return os;
      };
      var mobileOS = support.mobileOS = support.detectOS(navigator.userAgent);
      support.wpDevicePixelRatio = mobileOS.wp ? screen.width / 320 : 0;
      support.kineticScrollNeeded = mobileOS && (support.touch || support.msPointers || support.pointers);
      support.hasNativeScrolling = false;
      if (mobileOS.ios || (mobileOS.android && mobileOS.majorVersion > 2) || mobileOS.wp) {
        support.hasNativeScrolling = mobileOS;
      }
      support.mouseAndTouchPresent = support.touch && !(support.mobileOS.ios || support.mobileOS.android);
      support.detectBrowser = function(ua) {
        var browser = false,
            match = [],
            browserRxs = {
              webkit: /(chrome)[ \/]([\w.]+)/i,
              safari: /(webkit)[ \/]([\w.]+)/i,
              opera: /(opera)(?:.*version|)[ \/]([\w.]+)/i,
              msie: /(msie\s|trident.*? rv:)([\w.]+)/i,
              mozilla: /(mozilla)(?:.*? rv:([\w.]+)|)/i
            };
        for (var agent in browserRxs) {
          if (browserRxs.hasOwnProperty(agent)) {
            match = ua.match(browserRxs[agent]);
            if (match) {
              browser = {};
              browser[agent] = true;
              browser[match[1].toLowerCase().split(" ")[0].split("/")[0]] = true;
              browser.version = parseInt(document.documentMode || match[2], 10);
              break;
            }
          }
        }
        return browser;
      };
      support.browser = support.detectBrowser(navigator.userAgent);
      support.zoomLevel = function() {
        try {
          var browser = support.browser;
          var ie11WidthCorrection = 0;
          var docEl = document.documentElement;
          if (browser.msie && browser.version == 11 && docEl.scrollHeight > docEl.clientHeight && !support.touch) {
            ie11WidthCorrection = support.scrollbar();
          }
          return support.touch ? (docEl.clientWidth / window.innerWidth) : browser.msie && browser.version >= 10 ? (((top || window).document.documentElement.offsetWidth + ie11WidthCorrection) / (top || window).innerWidth) : 1;
        } catch (e) {
          return 1;
        }
      };
      support.cssBorderSpacing = typeof document.documentElement.style.borderSpacing != "undefined" && !(support.browser.msie && support.browser.version < 8);
      (function(browser) {
        var cssClass = "",
            docElement = $(document.documentElement),
            majorVersion = parseInt(browser.version, 10);
        if (browser.msie) {
          cssClass = "ie";
        } else if (browser.mozilla) {
          cssClass = "ff";
        } else if (browser.safari) {
          cssClass = "safari";
        } else if (browser.webkit) {
          cssClass = "webkit";
        } else if (browser.opera) {
          cssClass = "opera";
        }
        if (cssClass) {
          cssClass = "k-" + cssClass + " k-" + cssClass + majorVersion;
        }
        if (support.mobileOS) {
          cssClass += " k-mobile";
        }
        docElement.addClass(cssClass);
      })(support.browser);
      support.eventCapture = document.documentElement.addEventListener;
      var input = document.createElement("input");
      support.placeholder = "placeholder" in input;
      support.propertyChangeEvent = "onpropertychange" in input;
      support.input = (function() {
        var types = ["number", "date", "time", "month", "week", "datetime", "datetime-local"];
        var length = types.length;
        var value = "test";
        var result = {};
        var idx = 0;
        var type;
        for (; idx < length; idx++) {
          type = types[idx];
          input.setAttribute("type", type);
          input.value = value;
          result[type.replace("-", "")] = input.type !== "text" && input.value !== value;
        }
        return result;
      })();
      input.style.cssText = "float:left;";
      support.cssFloat = !!input.style.cssFloat;
      input = null;
      support.stableSort = (function() {
        var threshold = 513;
        var sorted = [{
          index: 0,
          field: "b"
        }];
        for (var i = 1; i < threshold; i++) {
          sorted.push({
            index: i,
            field: "a"
          });
        }
        sorted.sort(function(a, b) {
          return a.field > b.field ? 1 : (a.field < b.field ? -1 : 0);
        });
        return sorted[0].index === 1;
      })();
      support.matchesSelector = elementProto.webkitMatchesSelector || elementProto.mozMatchesSelector || elementProto.msMatchesSelector || elementProto.oMatchesSelector || elementProto.matchesSelector || elementProto.matches || function(selector) {
        var nodeList = document.querySelectorAll ? (this.parentNode || document).querySelectorAll(selector) || [] : $(selector),
            i = nodeList.length;
        while (i--) {
          if (nodeList[i] == this) {
            return true;
          }
        }
        return false;
      };
      support.pushState = window.history && window.history.pushState;
      var documentMode = document.documentMode;
      support.hashChange = ("onhashchange" in window) && !(support.browser.msie && (!documentMode || documentMode <= 8));
    })();
    function size(obj) {
      var result = 0,
          key;
      for (key in obj) {
        if (obj.hasOwnProperty(key) && key != "toJSON") {
          result++;
        }
      }
      return result;
    }
    function getOffset(element, type, positioned) {
      if (!type) {
        type = "offset";
      }
      var result = element[type](),
          mobileOS = support.mobileOS;
      if (support.browser.msie && (support.pointers || support.msPointers) && !positioned) {
        result.top -= (window.pageYOffset - document.documentElement.scrollTop);
        result.left -= (window.pageXOffset - document.documentElement.scrollLeft);
      }
      return result;
    }
    var directions = {
      left: {reverse: "right"},
      right: {reverse: "left"},
      down: {reverse: "up"},
      up: {reverse: "down"},
      top: {reverse: "bottom"},
      bottom: {reverse: "top"},
      "in": {reverse: "out"},
      out: {reverse: "in"}
    };
    function parseEffects(input) {
      var effects = {};
      each((typeof input === "string" ? input.split(" ") : input), function(idx) {
        effects[idx] = this;
      });
      return effects;
    }
    function fx(element) {
      return new kendo.effects.Element(element);
    }
    var effects = {};
    $.extend(effects, {
      enabled: true,
      Element: function(element) {
        this.element = $(element);
      },
      promise: function(element, options) {
        if (!element.is(":visible")) {
          element.css({display: element.data("olddisplay") || "block"}).css("display");
        }
        if (options.hide) {
          element.data("olddisplay", element.css("display")).hide();
        }
        if (options.init) {
          options.init();
        }
        if (options.completeCallback) {
          options.completeCallback(element);
        }
        element.dequeue();
      },
      disable: function() {
        this.enabled = false;
        this.promise = this.promiseShim;
      },
      enable: function() {
        this.enabled = true;
        this.promise = this.animatedPromise;
      }
    });
    effects.promiseShim = effects.promise;
    function prepareAnimationOptions(options, duration, reverse, complete) {
      if (typeof options === STRING) {
        if (isFunction(duration)) {
          complete = duration;
          duration = 400;
          reverse = false;
        }
        if (isFunction(reverse)) {
          complete = reverse;
          reverse = false;
        }
        if (typeof duration === BOOLEAN) {
          reverse = duration;
          duration = 400;
        }
        options = {
          effects: options,
          duration: duration,
          reverse: reverse,
          complete: complete
        };
      }
      return extend({
        effects: {},
        duration: 400,
        reverse: false,
        init: noop,
        teardown: noop,
        hide: false
      }, options, {
        completeCallback: options.complete,
        complete: noop
      });
    }
    function animate(element, options, duration, reverse, complete) {
      var idx = 0,
          length = element.length,
          instance;
      for (; idx < length; idx++) {
        instance = $(element[idx]);
        instance.queue(function() {
          effects.promise(instance, prepareAnimationOptions(options, duration, reverse, complete));
        });
      }
      return element;
    }
    function toggleClass(element, classes, options, add) {
      if (classes) {
        classes = classes.split(" ");
        each(classes, function(idx, value) {
          element.toggleClass(value, add);
        });
      }
      return element;
    }
    if (!("kendoAnimate" in $.fn)) {
      extend($.fn, {
        kendoStop: function(clearQueue, gotoEnd) {
          return this.stop(clearQueue, gotoEnd);
        },
        kendoAnimate: function(options, duration, reverse, complete) {
          return animate(this, options, duration, reverse, complete);
        },
        kendoAddClass: function(classes, options) {
          return kendo.toggleClass(this, classes, options, true);
        },
        kendoRemoveClass: function(classes, options) {
          return kendo.toggleClass(this, classes, options, false);
        },
        kendoToggleClass: function(classes, options, toggle) {
          return kendo.toggleClass(this, classes, options, toggle);
        }
      });
    }
    var ampRegExp = /&/g,
        ltRegExp = /</g,
        quoteRegExp = /"/g,
        aposRegExp = /'/g,
        gtRegExp = />/g;
    function htmlEncode(value) {
      return ("" + value).replace(ampRegExp, "&amp;").replace(ltRegExp, "&lt;").replace(gtRegExp, "&gt;").replace(quoteRegExp, "&quot;").replace(aposRegExp, "&#39;");
    }
    var eventTarget = function(e) {
      return e.target;
    };
    if (support.touch) {
      eventTarget = function(e) {
        var touches = "originalEvent" in e ? e.originalEvent.changedTouches : "changedTouches" in e ? e.changedTouches : null;
        return touches ? document.elementFromPoint(touches[0].clientX, touches[0].clientY) : e.target;
      };
      each(["swipe", "swipeLeft", "swipeRight", "swipeUp", "swipeDown", "doubleTap", "tap"], function(m, value) {
        $.fn[value] = function(callback) {
          return this.bind(value, callback);
        };
      });
    }
    if (support.touch) {
      if (!support.mobileOS) {
        support.mousedown = "mousedown touchstart";
        support.mouseup = "mouseup touchend";
        support.mousemove = "mousemove touchmove";
        support.mousecancel = "mouseleave touchcancel";
        support.click = "click";
        support.resize = "resize";
      } else {
        support.mousedown = "touchstart";
        support.mouseup = "touchend";
        support.mousemove = "touchmove";
        support.mousecancel = "touchcancel";
        support.click = "touchend";
        support.resize = "orientationchange";
      }
    } else if (support.pointers) {
      support.mousemove = "pointermove";
      support.mousedown = "pointerdown";
      support.mouseup = "pointerup";
      support.mousecancel = "pointercancel";
      support.click = "pointerup";
      support.resize = "orientationchange resize";
    } else if (support.msPointers) {
      support.mousemove = "MSPointerMove";
      support.mousedown = "MSPointerDown";
      support.mouseup = "MSPointerUp";
      support.mousecancel = "MSPointerCancel";
      support.click = "MSPointerUp";
      support.resize = "orientationchange resize";
    } else {
      support.mousemove = "mousemove";
      support.mousedown = "mousedown";
      support.mouseup = "mouseup";
      support.mousecancel = "mouseleave";
      support.click = "click";
      support.resize = "resize";
    }
    var wrapExpression = function(members, paramName) {
      var result = paramName || "d",
          index,
          idx,
          length,
          member,
          count = 1;
      for (idx = 0, length = members.length; idx < length; idx++) {
        member = members[idx];
        if (member !== "") {
          index = member.indexOf("[");
          if (index !== 0) {
            if (index == -1) {
              member = "." + member;
            } else {
              count++;
              member = "." + member.substring(0, index) + " || {})" + member.substring(index);
            }
          }
          count++;
          result += member + ((idx < length - 1) ? " || {})" : ")");
        }
      }
      return new Array(count).join("(") + result;
    },
        localUrlRe = /^([a-z]+:)?\/\//i;
    extend(kendo, {
      ui: kendo.ui || {},
      fx: kendo.fx || fx,
      effects: kendo.effects || effects,
      mobile: kendo.mobile || {},
      data: kendo.data || {},
      dataviz: kendo.dataviz || {},
      keys: {
        INSERT: 45,
        DELETE: 46,
        BACKSPACE: 8,
        TAB: 9,
        ENTER: 13,
        ESC: 27,
        LEFT: 37,
        UP: 38,
        RIGHT: 39,
        DOWN: 40,
        END: 35,
        HOME: 36,
        SPACEBAR: 32,
        PAGEUP: 33,
        PAGEDOWN: 34,
        F2: 113,
        F10: 121,
        F12: 123,
        NUMPAD_PLUS: 107,
        NUMPAD_MINUS: 109,
        NUMPAD_DOT: 110
      },
      support: kendo.support || support,
      animate: kendo.animate || animate,
      ns: "",
      attr: function(value) {
        return "data-" + kendo.ns + value;
      },
      getShadows: getShadows,
      wrap: wrap,
      deepExtend: deepExtend,
      getComputedStyles: getComputedStyles,
      isScrollable: isScrollable,
      size: size,
      toCamelCase: toCamelCase,
      toHyphens: toHyphens,
      getOffset: kendo.getOffset || getOffset,
      parseEffects: kendo.parseEffects || parseEffects,
      toggleClass: kendo.toggleClass || toggleClass,
      directions: kendo.directions || directions,
      Observable: Observable,
      Class: Class,
      Template: Template,
      template: proxy(Template.compile, Template),
      render: proxy(Template.render, Template),
      stringify: proxy(JSON.stringify, JSON),
      eventTarget: eventTarget,
      htmlEncode: htmlEncode,
      isLocalUrl: function(url) {
        return url && !localUrlRe.test(url);
      },
      expr: function(expression, safe, paramName) {
        expression = expression || "";
        if (typeof safe == STRING) {
          paramName = safe;
          safe = false;
        }
        paramName = paramName || "d";
        if (expression && expression.charAt(0) !== "[") {
          expression = "." + expression;
        }
        if (safe) {
          expression = expression.replace(/"([^.]*)\.([^"]*)"/g, '"$1_$DOT$_$2"');
          expression = expression.replace(/'([^.]*)\.([^']*)'/g, "'$1_$DOT$_$2'");
          expression = wrapExpression(expression.split("."), paramName);
          expression = expression.replace(/_\$DOT\$_/g, ".");
        } else {
          expression = paramName + expression;
        }
        return expression;
      },
      getter: function(expression, safe) {
        var key = expression + safe;
        return getterCache[key] = getterCache[key] || new Function("d", "return " + kendo.expr(expression, safe));
      },
      setter: function(expression) {
        return setterCache[expression] = setterCache[expression] || new Function("d,value", kendo.expr(expression) + "=value");
      },
      accessor: function(expression) {
        return {
          get: kendo.getter(expression),
          set: kendo.setter(expression)
        };
      },
      guid: function() {
        var id = "",
            i,
            random;
        for (i = 0; i < 32; i++) {
          random = math.random() * 16 | 0;
          if (i == 8 || i == 12 || i == 16 || i == 20) {
            id += "-";
          }
          id += (i == 12 ? 4 : (i == 16 ? (random & 3 | 8) : random)).toString(16);
        }
        return id;
      },
      roleSelector: function(role) {
        return role.replace(/(\S+)/g, "[" + kendo.attr("role") + "=$1],").slice(0, -1);
      },
      directiveSelector: function(directives) {
        var selectors = directives.split(" ");
        if (selectors) {
          for (var i = 0; i < selectors.length; i++) {
            if (selectors[i] != "view") {
              selectors[i] = selectors[i].replace(/(\w*)(view|bar|strip|over)$/, "$1-$2");
            }
          }
        }
        return selectors.join(" ").replace(/(\S+)/g, "kendo-mobile-$1,").slice(0, -1);
      },
      triggeredByInput: function(e) {
        return (/^(label|input|textarea|select)$/i).test(e.target.tagName);
      },
      logToConsole: function(message) {
        var console = window.console;
        if (!kendo.suppressLog && typeof(console) != "undefined" && console.log) {
          console.log(message);
        }
      }
    });
    var Widget = Observable.extend({
      init: function(element, options) {
        var that = this;
        that.element = kendo.jQuery(element).handler(that);
        that.angular("init", options);
        Observable.fn.init.call(that);
        var dataSource = options ? options.dataSource : null;
        if (dataSource) {
          options = extend({}, options, {dataSource: {}});
        }
        options = that.options = extend(true, {}, that.options, options);
        if (dataSource) {
          options.dataSource = dataSource;
        }
        if (!that.element.attr(kendo.attr("role"))) {
          that.element.attr(kendo.attr("role"), (options.name || "").toLowerCase());
        }
        that.element.data("kendo" + options.prefix + options.name, that);
        that.bind(that.events, options);
      },
      events: [],
      options: {prefix: ""},
      _hasBindingTarget: function() {
        return !!this.element[0].kendoBindingTarget;
      },
      _tabindex: function(target) {
        target = target || this.wrapper;
        var element = this.element,
            TABINDEX = "tabindex",
            tabindex = target.attr(TABINDEX) || element.attr(TABINDEX);
        element.removeAttr(TABINDEX);
        target.attr(TABINDEX, !isNaN(tabindex) ? tabindex : 0);
      },
      setOptions: function(options) {
        this._setEvents(options);
        $.extend(this.options, options);
      },
      _setEvents: function(options) {
        var that = this,
            idx = 0,
            length = that.events.length,
            e;
        for (; idx < length; idx++) {
          e = that.events[idx];
          if (that.options[e] && options[e]) {
            that.unbind(e, that.options[e]);
          }
        }
        that.bind(that.events, options);
      },
      resize: function(force) {
        var size = this.getSize(),
            currentSize = this._size;
        if (force || (size.width > 0 || size.height > 0) && (!currentSize || size.width !== currentSize.width || size.height !== currentSize.height)) {
          this._size = size;
          this._resize(size, force);
          this.trigger("resize", size);
        }
      },
      getSize: function() {
        return kendo.dimensions(this.element);
      },
      size: function(size) {
        if (!size) {
          return this.getSize();
        } else {
          this.setSize(size);
        }
      },
      setSize: $.noop,
      _resize: $.noop,
      destroy: function() {
        var that = this;
        that.element.removeData("kendo" + that.options.prefix + that.options.name);
        that.element.removeData("handler");
        that.unbind();
      },
      angular: function() {}
    });
    var DataBoundWidget = Widget.extend({
      dataItems: function() {
        return this.dataSource.flatView();
      },
      _angularItems: function(cmd) {
        var that = this;
        that.angular(cmd, function() {
          return {
            elements: that.items(),
            data: $.map(that.dataItems(), function(dataItem) {
              return {dataItem: dataItem};
            })
          };
        });
      }
    });
    kendo.dimensions = function(element, dimensions) {
      var domElement = element[0];
      if (dimensions) {
        element.css(dimensions);
      }
      return {
        width: domElement.offsetWidth,
        height: domElement.offsetHeight
      };
    };
    kendo.notify = noop;
    var templateRegExp = /template$/i,
        jsonRegExp = /^\s*(?:\{(?:.|\r\n|\n)*\}|\[(?:.|\r\n|\n)*\])\s*$/,
        jsonFormatRegExp = /^\{(\d+)(:[^\}]+)?\}|^\[[A-Za-z_]*\]$/,
        dashRegExp = /([A-Z])/g;
    function parseOption(element, option) {
      var value;
      if (option.indexOf("data") === 0) {
        option = option.substring(4);
        option = option.charAt(0).toLowerCase() + option.substring(1);
      }
      option = option.replace(dashRegExp, "-$1");
      value = element.getAttribute("data-" + kendo.ns + option);
      if (value === null) {
        value = undefined;
      } else if (value === "null") {
        value = null;
      } else if (value === "true") {
        value = true;
      } else if (value === "false") {
        value = false;
      } else if (numberRegExp.test(value)) {
        value = parseFloat(value);
      } else if (jsonRegExp.test(value) && !jsonFormatRegExp.test(value)) {
        value = new Function("return (" + value + ")")();
      }
      return value;
    }
    function parseOptions(element, options) {
      var result = {},
          option,
          value;
      for (option in options) {
        value = parseOption(element, option);
        if (value !== undefined) {
          if (templateRegExp.test(option)) {
            value = kendo.template($("#" + value).html());
          }
          result[option] = value;
        }
      }
      return result;
    }
    kendo.initWidget = function(element, options, roles) {
      var result,
          option,
          widget,
          idx,
          length,
          role,
          value,
          dataSource,
          fullPath,
          widgetKeyRegExp;
      if (!roles) {
        roles = kendo.ui.roles;
      } else if (roles.roles) {
        roles = roles.roles;
      }
      element = element.nodeType ? element : element[0];
      role = element.getAttribute("data-" + kendo.ns + "role");
      if (!role) {
        return ;
      }
      fullPath = role.indexOf(".") === -1;
      if (fullPath) {
        widget = roles[role];
      } else {
        widget = kendo.getter(role)(window);
      }
      var data = $(element).data(),
          widgetKey = widget ? "kendo" + widget.fn.options.prefix + widget.fn.options.name : "";
      if (fullPath) {
        widgetKeyRegExp = new RegExp("^kendo.*" + role + "$", "i");
      } else {
        widgetKeyRegExp = new RegExp("^" + widgetKey + "$", "i");
      }
      for (var key in data) {
        if (key.match(widgetKeyRegExp)) {
          if (key === widgetKey) {
            result = data[key];
          } else {
            return data[key];
          }
        }
      }
      if (!widget) {
        return ;
      }
      dataSource = parseOption(element, "dataSource");
      options = $.extend({}, parseOptions(element, widget.fn.options), options);
      if (dataSource) {
        if (typeof dataSource === STRING) {
          options.dataSource = kendo.getter(dataSource)(window);
        } else {
          options.dataSource = dataSource;
        }
      }
      for (idx = 0, length = widget.fn.events.length; idx < length; idx++) {
        option = widget.fn.events[idx];
        value = parseOption(element, option);
        if (value !== undefined) {
          options[option] = kendo.getter(value)(window);
        }
      }
      if (!result) {
        result = new widget(element, options);
      } else if (!$.isEmptyObject(options)) {
        result.setOptions(options);
      }
      return result;
    };
    kendo.rolesFromNamespaces = function(namespaces) {
      var roles = [],
          idx,
          length;
      if (!namespaces[0]) {
        namespaces = [kendo.ui, kendo.dataviz.ui];
      }
      for (idx = 0, length = namespaces.length; idx < length; idx++) {
        roles[idx] = namespaces[idx].roles;
      }
      return extend.apply(null, [{}].concat(roles.reverse()));
    };
    kendo.init = function(element) {
      var roles = kendo.rolesFromNamespaces(slice.call(arguments, 1));
      $(element).find("[data-" + kendo.ns + "role]").addBack().each(function() {
        kendo.initWidget(this, {}, roles);
      });
    };
    kendo.destroy = function(element) {
      $(element).find("[data-" + kendo.ns + "role]").addBack().each(function() {
        var data = $(this).data();
        for (var key in data) {
          if (key.indexOf("kendo") === 0 && typeof data[key].destroy === FUNCTION) {
            data[key].destroy();
          }
        }
      });
    };
    function containmentComparer(a, b) {
      return $.contains(a, b) ? -1 : 1;
    }
    function resizableWidget() {
      var widget = $(this);
      return ($.inArray(widget.attr("data-" + kendo.ns + "role"), ["slider", "rangeslider"]) > -1) || widget.is(":visible");
    }
    kendo.resize = function(element, force) {
      var widgets = $(element).find("[data-" + kendo.ns + "role]").addBack().filter(resizableWidget);
      if (!widgets.length) {
        return ;
      }
      var widgetsArray = $.makeArray(widgets);
      widgetsArray.sort(containmentComparer);
      $.each(widgetsArray, function() {
        var widget = kendo.widgetInstance($(this));
        if (widget) {
          widget.resize(force);
        }
      });
    };
    kendo.parseOptions = parseOptions;
    extend(kendo.ui, {
      Widget: Widget,
      DataBoundWidget: DataBoundWidget,
      roles: {},
      progress: function(container, toggle) {
        var mask = container.find(".k-loading-mask"),
            support = kendo.support,
            browser = support.browser,
            isRtl,
            leftRight,
            webkitCorrection,
            containerScrollLeft;
        if (toggle) {
          if (!mask.length) {
            isRtl = support.isRtl(container);
            leftRight = isRtl ? "right" : "left";
            containerScrollLeft = container.scrollLeft();
            webkitCorrection = browser.webkit ? (!isRtl ? 0 : container[0].scrollWidth - container.width() - 2 * containerScrollLeft) : 0;
            mask = $("<div class='k-loading-mask'><span class='k-loading-text'>Loading...</span><div class='k-loading-image'/><div class='k-loading-color'/></div>").width("100%").height("100%").css("top", container.scrollTop()).css(leftRight, Math.abs(containerScrollLeft) + webkitCorrection).prependTo(container);
          }
        } else if (mask) {
          mask.remove();
        }
      },
      plugin: function(widget, register, prefix) {
        var name = widget.fn.options.name,
            getter;
        register = register || kendo.ui;
        prefix = prefix || "";
        register[name] = widget;
        register.roles[name.toLowerCase()] = widget;
        getter = "getKendo" + prefix + name;
        name = "kendo" + prefix + name;
        $.fn[name] = function(options) {
          var value = this,
              args;
          if (typeof options === STRING) {
            args = slice.call(arguments, 1);
            this.each(function() {
              var widget = $.data(this, name),
                  method,
                  result;
              if (!widget) {
                throw new Error(kendo.format("Cannot call method '{0}' of {1} before it is initialized", options, name));
              }
              method = widget[options];
              if (typeof method !== FUNCTION) {
                throw new Error(kendo.format("Cannot find method '{0}' of {1}", options, name));
              }
              result = method.apply(widget, args);
              if (result !== undefined) {
                value = result;
                return false;
              }
            });
          } else {
            this.each(function() {
              new widget(this, options);
            });
          }
          return value;
        };
        $.fn[name].widget = widget;
        $.fn[getter] = function() {
          return this.data(name);
        };
      }
    });
    var ContainerNullObject = {
      bind: function() {
        return this;
      },
      nullObject: true,
      options: {}
    };
    var MobileWidget = Widget.extend({
      init: function(element, options) {
        Widget.fn.init.call(this, element, options);
        this.element.autoApplyNS();
        this.wrapper = this.element;
        this.element.addClass("km-widget");
      },
      destroy: function() {
        Widget.fn.destroy.call(this);
        this.element.kendoDestroy();
      },
      options: {prefix: "Mobile"},
      events: [],
      view: function() {
        var viewElement = this.element.closest(kendo.roleSelector("view splitview modalview drawer"));
        return kendo.widgetInstance(viewElement, kendo.mobile.ui) || ContainerNullObject;
      },
      viewHasNativeScrolling: function() {
        var view = this.view();
        return view && view.options.useNativeScrolling;
      },
      container: function() {
        var element = this.element.closest(kendo.roleSelector("view layout modalview drawer splitview"));
        return kendo.widgetInstance(element.eq(0), kendo.mobile.ui) || ContainerNullObject;
      }
    });
    extend(kendo.mobile, {
      init: function(element) {
        kendo.init(element, kendo.mobile.ui, kendo.ui, kendo.dataviz.ui);
      },
      appLevelNativeScrolling: function() {
        return kendo.mobile.application && kendo.mobile.application.options && kendo.mobile.application.options.useNativeScrolling;
      },
      roles: {},
      ui: {
        Widget: MobileWidget,
        DataBoundWidget: DataBoundWidget.extend(MobileWidget.prototype),
        roles: {},
        plugin: function(widget) {
          kendo.ui.plugin(widget, kendo.mobile.ui, "Mobile");
        }
      }
    });
    deepExtend(kendo.dataviz, {
      init: function(element) {
        kendo.init(element, kendo.dataviz.ui);
      },
      ui: {
        roles: {},
        themes: {},
        views: [],
        plugin: function(widget) {
          kendo.ui.plugin(widget, kendo.dataviz.ui);
        }
      },
      roles: {}
    });
    kendo.touchScroller = function(elements, options) {
      return $(elements).map(function(idx, element) {
        element = $(element);
        if (support.kineticScrollNeeded && kendo.mobile.ui.Scroller && !element.data("kendoMobileScroller")) {
          element.kendoMobileScroller(options);
          return element.data("kendoMobileScroller");
        } else {
          return false;
        }
      })[0];
    };
    kendo.preventDefault = function(e) {
      e.preventDefault();
    };
    kendo.widgetInstance = function(element, suites) {
      var role = element.data(kendo.ns + "role"),
          widgets = [],
          i,
          length;
      if (role) {
        if (role === "content") {
          role = "scroller";
        }
        if (suites) {
          if (suites[0]) {
            for (i = 0, length = suites.length; i < length; i++) {
              widgets.push(suites[i].roles[role]);
            }
          } else {
            widgets.push(suites.roles[role]);
          }
        } else {
          widgets = [kendo.ui.roles[role], kendo.dataviz.ui.roles[role], kendo.mobile.ui.roles[role]];
        }
        if (role.indexOf(".") >= 0) {
          widgets = [kendo.getter(role)(window)];
        }
        for (i = 0, length = widgets.length; i < length; i++) {
          var widget = widgets[i];
          if (widget) {
            var instance = element.data("kendo" + widget.fn.options.prefix + widget.fn.options.name);
            if (instance) {
              return instance;
            }
          }
        }
      }
    };
    kendo.onResize = function(callback) {
      var handler = callback;
      if (support.mobileOS.android) {
        handler = function() {
          setTimeout(callback, 600);
        };
      }
      $(window).on(support.resize, handler);
      return handler;
    };
    kendo.unbindResize = function(callback) {
      $(window).off(support.resize, callback);
    };
    kendo.attrValue = function(element, key) {
      return element.data(kendo.ns + key);
    };
    kendo.days = {
      Sunday: 0,
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6
    };
    function focusable(element, isTabIndexNotNaN) {
      var nodeName = element.nodeName.toLowerCase();
      return (/input|select|textarea|button|object/.test(nodeName) ? !element.disabled : "a" === nodeName ? element.href || isTabIndexNotNaN : isTabIndexNotNaN) && visible(element);
    }
    function visible(element) {
      return $.expr.filters.visible(element) && !$(element).parents().addBack().filter(function() {
        return $.css(this, "visibility") === "hidden";
      }).length;
    }
    $.extend($.expr[":"], {kendoFocusable: function(element) {
        var idx = $.attr(element, "tabindex");
        return focusable(element, !isNaN(idx) && idx > -1);
      }});
    var MOUSE_EVENTS = ["mousedown", "mousemove", "mouseenter", "mouseleave", "mouseover", "mouseout", "mouseup", "click"];
    var EXCLUDE_BUST_CLICK_SELECTOR = "label, input, [data-rel=external]";
    var MouseEventNormalizer = {
      setupMouseMute: function() {
        var idx = 0,
            length = MOUSE_EVENTS.length,
            element = document.documentElement;
        if (MouseEventNormalizer.mouseTrap || !support.eventCapture) {
          return ;
        }
        MouseEventNormalizer.mouseTrap = true;
        MouseEventNormalizer.bustClick = false;
        MouseEventNormalizer.captureMouse = false;
        var handler = function(e) {
          if (MouseEventNormalizer.captureMouse) {
            if (e.type === "click") {
              if (MouseEventNormalizer.bustClick && !$(e.target).is(EXCLUDE_BUST_CLICK_SELECTOR)) {
                e.preventDefault();
                e.stopPropagation();
              }
            } else {
              e.stopPropagation();
            }
          }
        };
        for (; idx < length; idx++) {
          element.addEventListener(MOUSE_EVENTS[idx], handler, true);
        }
      },
      muteMouse: function(e) {
        MouseEventNormalizer.captureMouse = true;
        if (e.data.bustClick) {
          MouseEventNormalizer.bustClick = true;
        }
        clearTimeout(MouseEventNormalizer.mouseTrapTimeoutID);
      },
      unMuteMouse: function() {
        clearTimeout(MouseEventNormalizer.mouseTrapTimeoutID);
        MouseEventNormalizer.mouseTrapTimeoutID = setTimeout(function() {
          MouseEventNormalizer.captureMouse = false;
          MouseEventNormalizer.bustClick = false;
        }, 400);
      }
    };
    var eventMap = {
      down: "touchstart mousedown",
      move: "mousemove touchmove",
      up: "mouseup touchend touchcancel",
      cancel: "mouseleave touchcancel"
    };
    if (support.touch && (support.mobileOS.ios || support.mobileOS.android)) {
      eventMap = {
        down: "touchstart",
        move: "touchmove",
        up: "touchend touchcancel",
        cancel: "touchcancel"
      };
    } else if (support.pointers) {
      eventMap = {
        down: "pointerdown",
        move: "pointermove",
        up: "pointerup",
        cancel: "pointercancel pointerleave"
      };
    } else if (support.msPointers) {
      eventMap = {
        down: "MSPointerDown",
        move: "MSPointerMove",
        up: "MSPointerUp",
        cancel: "MSPointerCancel MSPointerLeave"
      };
    }
    if (support.msPointers && !("onmspointerenter" in window)) {
      $.each({
        MSPointerEnter: "MSPointerOver",
        MSPointerLeave: "MSPointerOut"
      }, function(orig, fix) {
        $.event.special[orig] = {
          delegateType: fix,
          bindType: fix,
          handle: function(event) {
            var ret,
                target = this,
                related = event.relatedTarget,
                handleObj = event.handleObj;
            if (!related || (related !== target && !$.contains(target, related))) {
              event.type = handleObj.origType;
              ret = handleObj.handler.apply(this, arguments);
              event.type = fix;
            }
            return ret;
          }
        };
      });
    }
    var getEventMap = function(e) {
      return (eventMap[e] || e);
    },
        eventRegEx = /([^ ]+)/g;
    kendo.applyEventMap = function(events, ns) {
      events = events.replace(eventRegEx, getEventMap);
      if (ns) {
        events = events.replace(eventRegEx, "$1." + ns);
      }
      return events;
    };
    var on = $.fn.on;
    function kendoJQuery(selector, context) {
      return new kendoJQuery.fn.init(selector, context);
    }
    extend(true, kendoJQuery, $);
    kendoJQuery.fn = kendoJQuery.prototype = new $();
    kendoJQuery.fn.constructor = kendoJQuery;
    kendoJQuery.fn.init = function(selector, context) {
      if (context && context instanceof $ && !(context instanceof kendoJQuery)) {
        context = kendoJQuery(context);
      }
      return $.fn.init.call(this, selector, context, rootjQuery);
    };
    kendoJQuery.fn.init.prototype = kendoJQuery.fn;
    var rootjQuery = kendoJQuery(document);
    extend(kendoJQuery.fn, {
      handler: function(handler) {
        this.data("handler", handler);
        return this;
      },
      autoApplyNS: function(ns) {
        this.data("kendoNS", ns || kendo.guid());
        return this;
      },
      on: function() {
        var that = this,
            ns = that.data("kendoNS");
        if (arguments.length === 1) {
          return on.call(that, arguments[0]);
        }
        var context = that,
            args = slice.call(arguments);
        if (typeof args[args.length - 1] === UNDEFINED) {
          args.pop();
        }
        var callback = args[args.length - 1],
            events = kendo.applyEventMap(args[0], ns);
        if (support.mouseAndTouchPresent && events.search(/mouse|click/) > -1 && this[0] !== document.documentElement) {
          MouseEventNormalizer.setupMouseMute();
          var selector = args.length === 2 ? null : args[1],
              bustClick = events.indexOf("click") > -1 && events.indexOf("touchend") > -1;
          on.call(this, {
            touchstart: MouseEventNormalizer.muteMouse,
            touchend: MouseEventNormalizer.unMuteMouse
          }, selector, {bustClick: bustClick});
        }
        if (typeof callback === STRING) {
          context = that.data("handler");
          callback = context[callback];
          args[args.length - 1] = function(e) {
            callback.call(context, e);
          };
        }
        args[0] = events;
        on.apply(that, args);
        return that;
      },
      kendoDestroy: function(ns) {
        ns = ns || this.data("kendoNS");
        if (ns) {
          this.off("." + ns);
        }
        return this;
      }
    });
    kendo.jQuery = kendoJQuery;
    kendo.eventMap = eventMap;
    kendo.timezone = (function() {
      var months = {
        Jan: 0,
        Feb: 1,
        Mar: 2,
        Apr: 3,
        May: 4,
        Jun: 5,
        Jul: 6,
        Aug: 7,
        Sep: 8,
        Oct: 9,
        Nov: 10,
        Dec: 11
      };
      var days = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6
      };
      function ruleToDate(year, rule) {
        var date;
        var targetDay;
        var ourDay;
        var month = rule[3];
        var on = rule[4];
        var time = rule[5];
        var cache = rule[8];
        if (!cache) {
          rule[8] = cache = {};
        }
        if (cache[year]) {
          return cache[year];
        }
        if (!isNaN(on)) {
          date = new Date(Date.UTC(year, months[month], on, time[0], time[1], time[2], 0));
        } else if (on.indexOf("last") === 0) {
          date = new Date(Date.UTC(year, months[month] + 1, 1, time[0] - 24, time[1], time[2], 0));
          targetDay = days[on.substr(4, 3)];
          ourDay = date.getUTCDay();
          date.setUTCDate(date.getUTCDate() + targetDay - ourDay - (targetDay > ourDay ? 7 : 0));
        } else if (on.indexOf(">=") >= 0) {
          date = new Date(Date.UTC(year, months[month], on.substr(5), time[0], time[1], time[2], 0));
          targetDay = days[on.substr(0, 3)];
          ourDay = date.getUTCDay();
          date.setUTCDate(date.getUTCDate() + targetDay - ourDay + (targetDay < ourDay ? 7 : 0));
        }
        return cache[year] = date;
      }
      function findRule(utcTime, rules, zone) {
        rules = rules[zone];
        if (!rules) {
          var time = zone.split(":");
          var offset = 0;
          if (time.length > 1) {
            offset = time[0] * 60 + Number(time[1]);
          }
          return [-1000000, 'max', '-', 'Jan', 1, [0, 0, 0], offset, '-'];
        }
        var year = new Date(utcTime).getUTCFullYear();
        rules = jQuery.grep(rules, function(rule) {
          var from = rule[0];
          var to = rule[1];
          return from <= year && (to >= year || (from == year && to == "only") || to == "max");
        });
        rules.push(utcTime);
        rules.sort(function(a, b) {
          if (typeof a != "number") {
            a = Number(ruleToDate(year, a));
          }
          if (typeof b != "number") {
            b = Number(ruleToDate(year, b));
          }
          return a - b;
        });
        var rule = rules[jQuery.inArray(utcTime, rules) - 1] || rules[rules.length - 1];
        return isNaN(rule) ? rule : null;
      }
      function findZone(utcTime, zones, timezone) {
        var zoneRules = zones[timezone];
        if (typeof zoneRules === "string") {
          zoneRules = zones[zoneRules];
        }
        if (!zoneRules) {
          throw new Error('Timezone "' + timezone + '" is either incorrect, or kendo.timezones.min.js is not included.');
        }
        for (var idx = zoneRules.length - 1; idx >= 0; idx--) {
          var until = zoneRules[idx][3];
          if (until && utcTime > until) {
            break;
          }
        }
        var zone = zoneRules[idx + 1];
        if (!zone) {
          throw new Error('Timezone "' + timezone + '" not found on ' + utcTime + ".");
        }
        return zone;
      }
      function zoneAndRule(utcTime, zones, rules, timezone) {
        if (typeof utcTime != NUMBER) {
          utcTime = Date.UTC(utcTime.getFullYear(), utcTime.getMonth(), utcTime.getDate(), utcTime.getHours(), utcTime.getMinutes(), utcTime.getSeconds(), utcTime.getMilliseconds());
        }
        var zone = findZone(utcTime, zones, timezone);
        return {
          zone: zone,
          rule: findRule(utcTime, rules, zone[1])
        };
      }
      function offset(utcTime, timezone) {
        if (timezone == "Etc/UTC" || timezone == "Etc/GMT") {
          return 0;
        }
        var info = zoneAndRule(utcTime, this.zones, this.rules, timezone);
        var zone = info.zone;
        var rule = info.rule;
        return kendo.parseFloat(rule ? zone[0] - rule[6] : zone[0]);
      }
      function abbr(utcTime, timezone) {
        var info = zoneAndRule(utcTime, this.zones, this.rules, timezone);
        var zone = info.zone;
        var rule = info.rule;
        var base = zone[2];
        if (base.indexOf("/") >= 0) {
          return base.split("/")[rule && +rule[6] ? 1 : 0];
        } else if (base.indexOf("%s") >= 0) {
          return base.replace("%s", (!rule || rule[7] == "-") ? '' : rule[7]);
        }
        return base;
      }
      function convert(date, fromOffset, toOffset) {
        if (typeof fromOffset == STRING) {
          fromOffset = this.offset(date, fromOffset);
        }
        if (typeof toOffset == STRING) {
          toOffset = this.offset(date, toOffset);
        }
        var fromLocalOffset = date.getTimezoneOffset();
        date = new Date(date.getTime() + (fromOffset - toOffset) * 60000);
        var toLocalOffset = date.getTimezoneOffset();
        return new Date(date.getTime() + (toLocalOffset - fromLocalOffset) * 60000);
      }
      function apply(date, timezone) {
        return this.convert(date, date.getTimezoneOffset(), timezone);
      }
      function remove(date, timezone) {
        return this.convert(date, timezone, date.getTimezoneOffset());
      }
      function toLocalDate(time) {
        return this.apply(new Date(time), "Etc/UTC");
      }
      return {
        zones: {},
        rules: {},
        offset: offset,
        convert: convert,
        apply: apply,
        remove: remove,
        abbr: abbr,
        toLocalDate: toLocalDate
      };
    })();
    kendo.date = (function() {
      var MS_PER_MINUTE = 60000,
          MS_PER_DAY = 86400000;
      function adjustDST(date, hours) {
        if (hours === 0 && date.getHours() === 23) {
          date.setHours(date.getHours() + 2);
          return true;
        }
        return false;
      }
      function setDayOfWeek(date, day, dir) {
        var hours = date.getHours();
        dir = dir || 1;
        day = ((day - date.getDay()) + (7 * dir)) % 7;
        date.setDate(date.getDate() + day);
        adjustDST(date, hours);
      }
      function dayOfWeek(date, day, dir) {
        date = new Date(date);
        setDayOfWeek(date, day, dir);
        return date;
      }
      function firstDayOfMonth(date) {
        return new Date(date.getFullYear(), date.getMonth(), 1);
      }
      function lastDayOfMonth(date) {
        var last = new Date(date.getFullYear(), date.getMonth() + 1, 0),
            first = firstDayOfMonth(date),
            timeOffset = Math.abs(last.getTimezoneOffset() - first.getTimezoneOffset());
        if (timeOffset) {
          last.setHours(first.getHours() + (timeOffset / 60));
        }
        return last;
      }
      function getDate(date) {
        date = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
        adjustDST(date, 0);
        return date;
      }
      function toUtcTime(date) {
        return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
      }
      function getMilliseconds(date) {
        return date.getTime() - getDate(date);
      }
      function isInTimeRange(value, min, max) {
        var msMin = getMilliseconds(min),
            msMax = getMilliseconds(max),
            msValue;
        if (!value || msMin == msMax) {
          return true;
        }
        if (min >= max) {
          max += MS_PER_DAY;
        }
        msValue = getMilliseconds(value);
        if (msMin > msValue) {
          msValue += MS_PER_DAY;
        }
        if (msMax < msMin) {
          msMax += MS_PER_DAY;
        }
        return msValue >= msMin && msValue <= msMax;
      }
      function isInDateRange(value, min, max) {
        var msMin = min.getTime(),
            msMax = max.getTime(),
            msValue;
        if (msMin >= msMax) {
          msMax += MS_PER_DAY;
        }
        msValue = value.getTime();
        return msValue >= msMin && msValue <= msMax;
      }
      function addDays(date, offset) {
        var hours = date.getHours();
        date = new Date(date);
        setTime(date, offset * MS_PER_DAY);
        adjustDST(date, hours);
        return date;
      }
      function setTime(date, milliseconds, ignoreDST) {
        var offset = date.getTimezoneOffset();
        var difference;
        date.setTime(date.getTime() + milliseconds);
        if (!ignoreDST) {
          difference = date.getTimezoneOffset() - offset;
          date.setTime(date.getTime() + difference * MS_PER_MINUTE);
        }
      }
      function today() {
        return getDate(new Date());
      }
      function isToday(date) {
        return getDate(date).getTime() == today().getTime();
      }
      function toInvariantTime(date) {
        var staticDate = new Date(1980, 1, 1, 0, 0, 0);
        if (date) {
          staticDate.setHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
        }
        return staticDate;
      }
      return {
        adjustDST: adjustDST,
        dayOfWeek: dayOfWeek,
        setDayOfWeek: setDayOfWeek,
        getDate: getDate,
        isInDateRange: isInDateRange,
        isInTimeRange: isInTimeRange,
        isToday: isToday,
        nextDay: function(date) {
          return addDays(date, 1);
        },
        previousDay: function(date) {
          return addDays(date, -1);
        },
        toUtcTime: toUtcTime,
        MS_PER_DAY: MS_PER_DAY,
        MS_PER_HOUR: 60 * MS_PER_MINUTE,
        MS_PER_MINUTE: MS_PER_MINUTE,
        setTime: setTime,
        addDays: addDays,
        today: today,
        toInvariantTime: toInvariantTime,
        firstDayOfMonth: firstDayOfMonth,
        lastDayOfMonth: lastDayOfMonth,
        getMilliseconds: getMilliseconds
      };
    })();
    kendo.stripWhitespace = function(element) {
      if (document.createNodeIterator) {
        var iterator = document.createNodeIterator(element, NodeFilter.SHOW_TEXT, function(node) {
          return node.parentNode == element ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }, false);
        while (iterator.nextNode()) {
          if (iterator.referenceNode && !iterator.referenceNode.textContent.trim()) {
            iterator.referenceNode.parentNode.removeChild(iterator.referenceNode);
          }
        }
      } else {
        for (var i = 0; i < element.childNodes.length; i++) {
          var child = element.childNodes[i];
          if (child.nodeType == 3 && !/\S/.test(child.nodeValue)) {
            element.removeChild(child);
            i--;
          }
          if (child.nodeType == 1) {
            kendo.stripWhitespace(child);
          }
        }
      }
    };
    var animationFrame = window.requestAnimationFrame || window.webkitRequestAnimationFrame || window.mozRequestAnimationFrame || window.oRequestAnimationFrame || window.msRequestAnimationFrame || function(callback) {
      setTimeout(callback, 1000 / 60);
    };
    kendo.animationFrame = function(callback) {
      animationFrame.call(window, callback);
    };
    var animationQueue = [];
    kendo.queueAnimation = function(callback) {
      animationQueue[animationQueue.length] = callback;
      if (animationQueue.length === 1) {
        kendo.runNextAnimation();
      }
    };
    kendo.runNextAnimation = function() {
      kendo.animationFrame(function() {
        if (animationQueue[0]) {
          animationQueue.shift()();
          if (animationQueue[0]) {
            kendo.runNextAnimation();
          }
        }
      });
    };
    kendo.parseQueryStringParams = function(url) {
      var queryString = url.split('?')[1] || "",
          params = {},
          paramParts = queryString.split(/&|=/),
          length = paramParts.length,
          idx = 0;
      for (; idx < length; idx += 2) {
        if (paramParts[idx] !== "") {
          params[decodeURIComponent(paramParts[idx])] = decodeURIComponent(paramParts[idx + 1]);
        }
      }
      return params;
    };
    kendo.elementUnderCursor = function(e) {
      if (typeof e.x.client != "undefined") {
        return document.elementFromPoint(e.x.client, e.y.client);
      }
    };
    kendo.wheelDeltaY = function(jQueryEvent) {
      var e = jQueryEvent.originalEvent,
          deltaY = e.wheelDeltaY,
          delta;
      if (e.wheelDelta) {
        if (deltaY === undefined || deltaY) {
          delta = e.wheelDelta;
        }
      } else if (e.detail && e.axis === e.VERTICAL_AXIS) {
        delta = (-e.detail) * 10;
      }
      return delta;
    };
    kendo.throttle = function(fn, delay) {
      var timeout;
      var lastExecTime = 0;
      if (!delay || delay <= 0) {
        return fn;
      }
      var throttled = function() {
        var that = this;
        var elapsed = +new Date() - lastExecTime;
        var args = arguments;
        function exec() {
          fn.apply(that, args);
          lastExecTime = +new Date();
        }
        if (!lastExecTime) {
          return exec();
        }
        if (timeout) {
          clearTimeout(timeout);
        }
        if (elapsed > delay) {
          exec();
        } else {
          timeout = setTimeout(exec, delay - elapsed);
        }
      };
      throttled.cancel = function() {
        clearTimeout(timeout);
      };
      return throttled;
    };
    kendo.caret = function(element, start, end) {
      var rangeElement;
      var isPosition = start !== undefined;
      if (end === undefined) {
        end = start;
      }
      if (element[0]) {
        element = element[0];
      }
      if (isPosition && element.disabled) {
        return ;
      }
      try {
        if (element.selectionStart !== undefined) {
          if (isPosition) {
            element.focus();
            element.setSelectionRange(start, end);
          } else {
            start = [element.selectionStart, element.selectionEnd];
          }
        } else if (document.selection) {
          if ($(element).is(":visible")) {
            element.focus();
          }
          rangeElement = element.createTextRange();
          if (isPosition) {
            rangeElement.collapse(true);
            rangeElement.moveStart("character", start);
            rangeElement.moveEnd("character", end - start);
            rangeElement.select();
          } else {
            var rangeDuplicated = rangeElement.duplicate(),
                selectionStart,
                selectionEnd;
            rangeElement.moveToBookmark(document.selection.createRange().getBookmark());
            rangeDuplicated.setEndPoint('EndToStart', rangeElement);
            selectionStart = rangeDuplicated.text.length;
            selectionEnd = selectionStart + rangeElement.text.length;
            start = [selectionStart, selectionEnd];
          }
        }
      } catch (e) {
        start = [];
      }
      return start;
    };
    kendo.compileMobileDirective = function(element, scope) {
      var angular = window.angular;
      element.attr("data-" + kendo.ns + "role", element[0].tagName.toLowerCase().replace('kendo-mobile-', '').replace('-', ''));
      angular.element(element).injector().invoke(["$compile", function($compile) {
        $compile(element)(scope);
        if (!/^\$(digest|apply)$/.test(scope.$$phase)) {
          scope.$digest();
        }
      }]);
      return kendo.widgetInstance(element, kendo.mobile.ui);
    };
    kendo.antiForgeryTokens = function() {
      var tokens = {},
          csrf_token = $("meta[name=csrf-token],meta[name=_csrf]").attr("content"),
          csrf_param = $("meta[name=csrf-param],meta[name=_csrf_header]").attr("content");
      $("input[name^='__RequestVerificationToken']").each(function() {
        tokens[this.name] = this.value;
      });
      if (csrf_param !== undefined && csrf_token !== undefined) {
        tokens[csrf_param] = csrf_token;
      }
      return tokens;
    };
    kendo.cycleForm = function(form) {
      var firstElement = form.find("input, .k-widget").first();
      var lastElement = form.find("button, .k-button").last();
      function focus(el) {
        var widget = kendo.widgetInstance(el);
        if (widget && widget.focus) {
          widget.focus();
        } else {
          el.focus();
        }
      }
      lastElement.on("keydown", function(e) {
        if (e.keyCode == kendo.keys.TAB && !e.shiftKey) {
          e.preventDefault();
          focus(firstElement);
        }
      });
      firstElement.on("keydown", function(e) {
        if (e.keyCode == kendo.keys.TAB && e.shiftKey) {
          e.preventDefault();
          focus(lastElement);
        }
      });
    };
    (function() {
      function postToProxy(dataURI, fileName, proxyURL, proxyTarget) {
        var form = $("<form>").attr({
          action: proxyURL,
          method: "POST",
          target: proxyTarget
        });
        var data = kendo.antiForgeryTokens();
        data.fileName = fileName;
        var parts = dataURI.split(";base64,");
        data.contentType = parts[0].replace("data:", "");
        data.base64 = parts[1];
        for (var name in data) {
          if (data.hasOwnProperty(name)) {
            $('<input>').attr({
              value: data[name],
              name: name,
              type: "hidden"
            }).appendTo(form);
          }
        }
        form.appendTo("body").submit().remove();
      }
      var fileSaver = document.createElement("a");
      var downloadAttribute = "download" in fileSaver;
      function saveAsBlob(dataURI, fileName) {
        var blob = dataURI;
        if (typeof dataURI == "string") {
          var parts = dataURI.split(";base64,");
          var contentType = parts[0];
          var base64 = atob(parts[1]);
          var array = new Uint8Array(base64.length);
          for (var idx = 0; idx < base64.length; idx++) {
            array[idx] = base64.charCodeAt(idx);
          }
          blob = new Blob([array.buffer], {type: contentType});
        }
        navigator.msSaveBlob(blob, fileName);
      }
      function saveAsDataURI(dataURI, fileName) {
        if (window.Blob && dataURI instanceof Blob) {
          dataURI = URL.createObjectURL(dataURI);
        }
        fileSaver.download = fileName;
        fileSaver.href = dataURI;
        var e = document.createEvent("MouseEvents");
        e.initMouseEvent("click", true, false, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null);
        fileSaver.dispatchEvent(e);
      }
      kendo.saveAs = function(options) {
        var save = postToProxy;
        if (!options.forceProxy) {
          if (downloadAttribute) {
            save = saveAsDataURI;
          } else if (navigator.msSaveBlob) {
            save = saveAsBlob;
          }
        }
        save(options.dataURI, options.fileName, options.proxyURL, options.proxyTarget);
      };
    })();
  })(jQuery, window);
  return window.kendo;
}, typeof define == 'function' && define.amd ? define : function(_, f) {
  f();
});
})();
(function() {
function define(){};  define.amd = {};
(function(f, define) {
  define(["./kendo.core", "./kendo.data.odata", "./kendo.data.xml"], f);
})(function() {
  (function($, undefined) {
    var extend = $.extend,
        proxy = $.proxy,
        isPlainObject = $.isPlainObject,
        isEmptyObject = $.isEmptyObject,
        isArray = $.isArray,
        grep = $.grep,
        ajax = $.ajax,
        map,
        each = $.each,
        noop = $.noop,
        kendo = window.kendo,
        isFunction = kendo.isFunction,
        Observable = kendo.Observable,
        Class = kendo.Class,
        STRING = "string",
        FUNCTION = "function",
        CREATE = "create",
        READ = "read",
        UPDATE = "update",
        DESTROY = "destroy",
        CHANGE = "change",
        SYNC = "sync",
        GET = "get",
        ERROR = "error",
        REQUESTSTART = "requestStart",
        PROGRESS = "progress",
        REQUESTEND = "requestEnd",
        crud = [CREATE, READ, UPDATE, DESTROY],
        identity = function(o) {
          return o;
        },
        getter = kendo.getter,
        stringify = kendo.stringify,
        math = Math,
        push = [].push,
        join = [].join,
        pop = [].pop,
        splice = [].splice,
        shift = [].shift,
        slice = [].slice,
        unshift = [].unshift,
        toString = {}.toString,
        stableSort = kendo.support.stableSort,
        dateRegExp = /^\/Date\((.*?)\)\/$/,
        newLineRegExp = /(\r+|\n+)/g,
        quoteRegExp = /(?=['\\])/g;
    var ObservableArray = Observable.extend({
      init: function(array, type) {
        var that = this;
        that.type = type || ObservableObject;
        Observable.fn.init.call(that);
        that.length = array.length;
        that.wrapAll(array, that);
      },
      at: function(index) {
        return this[index];
      },
      toJSON: function() {
        var idx,
            length = this.length,
            value,
            json = new Array(length);
        for (idx = 0; idx < length; idx++) {
          value = this[idx];
          if (value instanceof ObservableObject) {
            value = value.toJSON();
          }
          json[idx] = value;
        }
        return json;
      },
      parent: noop,
      wrapAll: function(source, target) {
        var that = this,
            idx,
            length,
            parent = function() {
              return that;
            };
        target = target || [];
        for (idx = 0, length = source.length; idx < length; idx++) {
          target[idx] = that.wrap(source[idx], parent);
        }
        return target;
      },
      wrap: function(object, parent) {
        var that = this,
            observable;
        if (object !== null && toString.call(object) === "[object Object]") {
          observable = object instanceof that.type || object instanceof Model;
          if (!observable) {
            object = object instanceof ObservableObject ? object.toJSON() : object;
            object = new that.type(object);
          }
          object.parent = parent;
          object.bind(CHANGE, function(e) {
            that.trigger(CHANGE, {
              field: e.field,
              node: e.node,
              index: e.index,
              items: e.items || [this],
              action: e.node ? (e.action || "itemloaded") : "itemchange"
            });
          });
        }
        return object;
      },
      push: function() {
        var index = this.length,
            items = this.wrapAll(arguments),
            result;
        result = push.apply(this, items);
        this.trigger(CHANGE, {
          action: "add",
          index: index,
          items: items
        });
        return result;
      },
      slice: slice,
      sort: [].sort,
      join: join,
      pop: function() {
        var length = this.length,
            result = pop.apply(this);
        if (length) {
          this.trigger(CHANGE, {
            action: "remove",
            index: length - 1,
            items: [result]
          });
        }
        return result;
      },
      splice: function(index, howMany, item) {
        var items = this.wrapAll(slice.call(arguments, 2)),
            result,
            i,
            len;
        result = splice.apply(this, [index, howMany].concat(items));
        if (result.length) {
          this.trigger(CHANGE, {
            action: "remove",
            index: index,
            items: result
          });
          for (i = 0, len = result.length; i < len; i++) {
            if (result[i] && result[i].children) {
              result[i].unbind(CHANGE);
            }
          }
        }
        if (item) {
          this.trigger(CHANGE, {
            action: "add",
            index: index,
            items: items
          });
        }
        return result;
      },
      shift: function() {
        var length = this.length,
            result = shift.apply(this);
        if (length) {
          this.trigger(CHANGE, {
            action: "remove",
            index: 0,
            items: [result]
          });
        }
        return result;
      },
      unshift: function() {
        var items = this.wrapAll(arguments),
            result;
        result = unshift.apply(this, items);
        this.trigger(CHANGE, {
          action: "add",
          index: 0,
          items: items
        });
        return result;
      },
      indexOf: function(item) {
        var that = this,
            idx,
            length;
        for (idx = 0, length = that.length; idx < length; idx++) {
          if (that[idx] === item) {
            return idx;
          }
        }
        return -1;
      },
      forEach: function(callback) {
        var idx = 0,
            length = this.length;
        for (; idx < length; idx++) {
          callback(this[idx], idx, this);
        }
      },
      map: function(callback) {
        var idx = 0,
            result = [],
            length = this.length;
        for (; idx < length; idx++) {
          result[idx] = callback(this[idx], idx, this);
        }
        return result;
      },
      reduce: function(callback, initialValue) {
        var idx = 0,
            result,
            length = this.length;
        if (arguments.length == 2) {
          result = arguments[1];
        } else if (idx < length) {
          result = this[idx++];
        }
        for (; idx < length; idx++) {
          result = callback(result, this[idx], idx, this);
        }
        return result;
      },
      reduceRight: function(callback, initialValue) {
        var idx = this.length - 1,
            result;
        if (arguments.length == 2) {
          result = arguments[1];
        } else if (idx > 0) {
          result = this[idx--];
        }
        for (; idx >= 0; idx--) {
          result = callback(result, this[idx], idx, this);
        }
        return result;
      },
      filter: function(callback) {
        var idx = 0,
            result = [],
            item,
            length = this.length;
        for (; idx < length; idx++) {
          item = this[idx];
          if (callback(item, idx, this)) {
            result[result.length] = item;
          }
        }
        return result;
      },
      find: function(callback) {
        var idx = 0,
            item,
            length = this.length;
        for (; idx < length; idx++) {
          item = this[idx];
          if (callback(item, idx, this)) {
            return item;
          }
        }
      },
      every: function(callback) {
        var idx = 0,
            item,
            length = this.length;
        for (; idx < length; idx++) {
          item = this[idx];
          if (!callback(item, idx, this)) {
            return false;
          }
        }
        return true;
      },
      some: function(callback) {
        var idx = 0,
            item,
            length = this.length;
        for (; idx < length; idx++) {
          item = this[idx];
          if (callback(item, idx, this)) {
            return true;
          }
        }
        return false;
      },
      remove: function(item) {
        var idx = this.indexOf(item);
        if (idx !== -1) {
          this.splice(idx, 1);
        }
      },
      empty: function() {
        this.splice(0, this.length);
      }
    });
    var LazyObservableArray = ObservableArray.extend({
      init: function(data, type) {
        Observable.fn.init.call(this);
        this.type = type || ObservableObject;
        for (var idx = 0; idx < data.length; idx++) {
          this[idx] = data[idx];
        }
        this.length = idx;
        this._parent = proxy(function() {
          return this;
        }, this);
      },
      at: function(index) {
        var item = this[index];
        if (!(item instanceof this.type)) {
          item = this[index] = this.wrap(item, this._parent);
        } else {
          item.parent = this._parent;
        }
        return item;
      }
    });
    function eventHandler(context, type, field, prefix) {
      return function(e) {
        var event = {},
            key;
        for (key in e) {
          event[key] = e[key];
        }
        if (prefix) {
          event.field = field + "." + e.field;
        } else {
          event.field = field;
        }
        if (type == CHANGE && context._notifyChange) {
          context._notifyChange(event);
        }
        context.trigger(type, event);
      };
    }
    var ObservableObject = Observable.extend({
      init: function(value) {
        var that = this,
            member,
            field,
            parent = function() {
              return that;
            };
        Observable.fn.init.call(this);
        for (field in value) {
          member = value[field];
          if (typeof member === "object" && member && !member.getTime && field.charAt(0) != "_") {
            member = that.wrap(member, field, parent);
          }
          that[field] = member;
        }
        that.uid = kendo.guid();
      },
      shouldSerialize: function(field) {
        return this.hasOwnProperty(field) && field !== "_events" && typeof this[field] !== FUNCTION && field !== "uid";
      },
      forEach: function(f) {
        for (var i in this) {
          if (this.shouldSerialize(i)) {
            f(this[i], i);
          }
        }
      },
      toJSON: function() {
        var result = {},
            value,
            field;
        for (field in this) {
          if (this.shouldSerialize(field)) {
            value = this[field];
            if (value instanceof ObservableObject || value instanceof ObservableArray) {
              value = value.toJSON();
            }
            result[field] = value;
          }
        }
        return result;
      },
      get: function(field) {
        var that = this,
            result;
        that.trigger(GET, {field: field});
        if (field === "this") {
          result = that;
        } else {
          result = kendo.getter(field, true)(that);
        }
        return result;
      },
      _set: function(field, value) {
        var that = this;
        var composite = field.indexOf(".") >= 0;
        if (composite) {
          var paths = field.split("."),
              path = "";
          while (paths.length > 1) {
            path += paths.shift();
            var obj = kendo.getter(path, true)(that);
            if (obj instanceof ObservableObject) {
              obj.set(paths.join("."), value);
              return composite;
            }
            path += ".";
          }
        }
        kendo.setter(field)(that, value);
        return composite;
      },
      set: function(field, value) {
        var that = this,
            composite = field.indexOf(".") >= 0,
            current = kendo.getter(field, true)(that);
        if (current !== value) {
          if (!that.trigger("set", {
            field: field,
            value: value
          })) {
            if (!composite) {
              value = that.wrap(value, field, function() {
                return that;
              });
            }
            if (!that._set(field, value) || field.indexOf("(") >= 0 || field.indexOf("[") >= 0) {
              that.trigger(CHANGE, {field: field});
            }
          }
        }
      },
      parent: noop,
      wrap: function(object, field, parent) {
        var that = this,
            type = toString.call(object);
        if (object != null && (type === "[object Object]" || type === "[object Array]")) {
          var isObservableArray = object instanceof ObservableArray;
          var isDataSource = object instanceof DataSource;
          if (type === "[object Object]" && !isDataSource && !isObservableArray) {
            if (!(object instanceof ObservableObject)) {
              object = new ObservableObject(object);
            }
            if (object.parent() != parent()) {
              object.bind(GET, eventHandler(that, GET, field, true));
              object.bind(CHANGE, eventHandler(that, CHANGE, field, true));
            }
          } else if (type === "[object Array]" || isObservableArray || isDataSource) {
            if (!isObservableArray && !isDataSource) {
              object = new ObservableArray(object);
            }
            if (object.parent() != parent()) {
              object.bind(CHANGE, eventHandler(that, CHANGE, field, false));
            }
          }
          object.parent = parent;
        }
        return object;
      }
    });
    function equal(x, y) {
      if (x === y) {
        return true;
      }
      var xtype = $.type(x),
          ytype = $.type(y),
          field;
      if (xtype !== ytype) {
        return false;
      }
      if (xtype === "date") {
        return x.getTime() === y.getTime();
      }
      if (xtype !== "object" && xtype !== "array") {
        return false;
      }
      for (field in x) {
        if (!equal(x[field], y[field])) {
          return false;
        }
      }
      return true;
    }
    var parsers = {
      "number": function(value) {
        return kendo.parseFloat(value);
      },
      "date": function(value) {
        return kendo.parseDate(value);
      },
      "boolean": function(value) {
        if (typeof value === STRING) {
          return value.toLowerCase() === "true";
        }
        return value != null ? !!value : value;
      },
      "string": function(value) {
        return value != null ? (value + "") : value;
      },
      "default": function(value) {
        return value;
      }
    };
    var defaultValues = {
      "string": "",
      "number": 0,
      "date": new Date(),
      "boolean": false,
      "default": ""
    };
    function getFieldByName(obj, name) {
      var field,
          fieldName;
      for (fieldName in obj) {
        field = obj[fieldName];
        if (isPlainObject(field) && field.field && field.field === name) {
          return field;
        } else if (field === name) {
          return field;
        }
      }
      return null;
    }
    var Model = ObservableObject.extend({
      init: function(data) {
        var that = this;
        if (!data || $.isEmptyObject(data)) {
          data = $.extend({}, that.defaults, data);
          if (that._initializers) {
            for (var idx = 0; idx < that._initializers.length; idx++) {
              var name = that._initializers[idx];
              data[name] = that.defaults[name]();
            }
          }
        }
        ObservableObject.fn.init.call(that, data);
        that.dirty = false;
        if (that.idField) {
          that.id = that.get(that.idField);
          if (that.id === undefined) {
            that.id = that._defaultId;
          }
        }
      },
      shouldSerialize: function(field) {
        return ObservableObject.fn.shouldSerialize.call(this, field) && field !== "uid" && !(this.idField !== "id" && field === "id") && field !== "dirty" && field !== "_accessors";
      },
      _parse: function(field, value) {
        var that = this,
            fieldName = field,
            fields = (that.fields || {}),
            parse;
        field = fields[field];
        if (!field) {
          field = getFieldByName(fields, fieldName);
        }
        if (field) {
          parse = field.parse;
          if (!parse && field.type) {
            parse = parsers[field.type.toLowerCase()];
          }
        }
        return parse ? parse(value) : value;
      },
      _notifyChange: function(e) {
        var action = e.action;
        if (action == "add" || action == "remove") {
          this.dirty = true;
        }
      },
      editable: function(field) {
        field = (this.fields || {})[field];
        return field ? field.editable !== false : true;
      },
      set: function(field, value, initiator) {
        var that = this;
        if (that.editable(field)) {
          value = that._parse(field, value);
          if (!equal(value, that.get(field))) {
            that.dirty = true;
            ObservableObject.fn.set.call(that, field, value, initiator);
          }
        }
      },
      accept: function(data) {
        var that = this,
            parent = function() {
              return that;
            },
            field;
        for (field in data) {
          var value = data[field];
          if (field.charAt(0) != "_") {
            value = that.wrap(data[field], field, parent);
          }
          that._set(field, value);
        }
        if (that.idField) {
          that.id = that.get(that.idField);
        }
        that.dirty = false;
      },
      isNew: function() {
        return this.id === this._defaultId;
      }
    });
    Model.define = function(base, options) {
      if (options === undefined) {
        options = base;
        base = Model;
      }
      var model,
          proto = extend({defaults: {}}, options),
          name,
          field,
          type,
          value,
          idx,
          length,
          fields = {},
          originalName,
          id = proto.id,
          functionFields = [];
      if (id) {
        proto.idField = id;
      }
      if (proto.id) {
        delete proto.id;
      }
      if (id) {
        proto.defaults[id] = proto._defaultId = "";
      }
      if (toString.call(proto.fields) === "[object Array]") {
        for (idx = 0, length = proto.fields.length; idx < length; idx++) {
          field = proto.fields[idx];
          if (typeof field === STRING) {
            fields[field] = {};
          } else if (field.field) {
            fields[field.field] = field;
          }
        }
        proto.fields = fields;
      }
      for (name in proto.fields) {
        field = proto.fields[name];
        type = field.type || "default";
        value = null;
        originalName = name;
        name = typeof(field.field) === STRING ? field.field : name;
        if (!field.nullable) {
          value = proto.defaults[originalName !== name ? originalName : name] = field.defaultValue !== undefined ? field.defaultValue : defaultValues[type.toLowerCase()];
          if (typeof value === "function") {
            functionFields.push(name);
          }
        }
        if (options.id === name) {
          proto._defaultId = value;
        }
        proto.defaults[originalName !== name ? originalName : name] = value;
        field.parse = field.parse || parsers[type];
      }
      if (functionFields.length > 0) {
        proto._initializers = functionFields;
      }
      model = base.extend(proto);
      model.define = function(options) {
        return Model.define(model, options);
      };
      if (proto.fields) {
        model.fields = proto.fields;
        model.idField = proto.idField;
      }
      return model;
    };
    var Comparer = {
      selector: function(field) {
        return isFunction(field) ? field : getter(field);
      },
      compare: function(field) {
        var selector = this.selector(field);
        return function(a, b) {
          a = selector(a);
          b = selector(b);
          if (a == null && b == null) {
            return 0;
          }
          if (a == null) {
            return -1;
          }
          if (b == null) {
            return 1;
          }
          if (a.localeCompare) {
            return a.localeCompare(b);
          }
          return a > b ? 1 : (a < b ? -1 : 0);
        };
      },
      create: function(sort) {
        var compare = sort.compare || this.compare(sort.field);
        if (sort.dir == "desc") {
          return function(a, b) {
            return compare(b, a, true);
          };
        }
        return compare;
      },
      combine: function(comparers) {
        return function(a, b) {
          var result = comparers[0](a, b),
              idx,
              length;
          for (idx = 1, length = comparers.length; idx < length; idx++) {
            result = result || comparers[idx](a, b);
          }
          return result;
        };
      }
    };
    var StableComparer = extend({}, Comparer, {
      asc: function(field) {
        var selector = this.selector(field);
        return function(a, b) {
          var valueA = selector(a);
          var valueB = selector(b);
          if (valueA && valueA.getTime && valueB && valueB.getTime) {
            valueA = valueA.getTime();
            valueB = valueB.getTime();
          }
          if (valueA === valueB) {
            return a.__position - b.__position;
          }
          if (valueA == null) {
            return -1;
          }
          if (valueB == null) {
            return 1;
          }
          if (valueA.localeCompare) {
            return valueA.localeCompare(valueB);
          }
          return valueA > valueB ? 1 : -1;
        };
      },
      desc: function(field) {
        var selector = this.selector(field);
        return function(a, b) {
          var valueA = selector(a);
          var valueB = selector(b);
          if (valueA && valueA.getTime && valueB && valueB.getTime) {
            valueA = valueA.getTime();
            valueB = valueB.getTime();
          }
          if (valueA === valueB) {
            return a.__position - b.__position;
          }
          if (valueA == null) {
            return 1;
          }
          if (valueB == null) {
            return -1;
          }
          if (valueB.localeCompare) {
            return valueB.localeCompare(valueA);
          }
          return valueA < valueB ? 1 : -1;
        };
      },
      create: function(sort) {
        return this[sort.dir](sort.field);
      }
    });
    map = function(array, callback) {
      var idx,
          length = array.length,
          result = new Array(length);
      for (idx = 0; idx < length; idx++) {
        result[idx] = callback(array[idx], idx, array);
      }
      return result;
    };
    var operators = (function() {
      function quote(value) {
        return value.replace(quoteRegExp, "\\").replace(newLineRegExp, "");
      }
      function operator(op, a, b, ignore) {
        var date;
        if (b != null) {
          if (typeof b === STRING) {
            b = quote(b);
            date = dateRegExp.exec(b);
            if (date) {
              b = new Date(+date[1]);
            } else if (ignore) {
              b = "'" + b.toLowerCase() + "'";
              a = "(" + a + " || '').toLowerCase()";
            } else {
              b = "'" + b + "'";
            }
          }
          if (b.getTime) {
            a = "(" + a + "?" + a + ".getTime():" + a + ")";
            b = b.getTime();
          }
        }
        return a + " " + op + " " + b;
      }
      return {
        quote: function(value) {
          if (value && value.getTime) {
            return "new Date(" + value.getTime() + ")";
          }
          if (typeof value == "string") {
            return "'" + quote(value) + "'";
          }
          return "" + value;
        },
        eq: function(a, b, ignore) {
          return operator("==", a, b, ignore);
        },
        neq: function(a, b, ignore) {
          return operator("!=", a, b, ignore);
        },
        gt: function(a, b, ignore) {
          return operator(">", a, b, ignore);
        },
        gte: function(a, b, ignore) {
          return operator(">=", a, b, ignore);
        },
        lt: function(a, b, ignore) {
          return operator("<", a, b, ignore);
        },
        lte: function(a, b, ignore) {
          return operator("<=", a, b, ignore);
        },
        startswith: function(a, b, ignore) {
          if (ignore) {
            a = "(" + a + " || '').toLowerCase()";
            if (b) {
              b = b.toLowerCase();
            }
          }
          if (b) {
            b = quote(b);
          }
          return a + ".lastIndexOf('" + b + "', 0) == 0";
        },
        endswith: function(a, b, ignore) {
          if (ignore) {
            a = "(" + a + " || '').toLowerCase()";
            if (b) {
              b = b.toLowerCase();
            }
          }
          if (b) {
            b = quote(b);
          }
          return a + ".indexOf('" + b + "', " + a + ".length - " + (b || "").length + ") >= 0";
        },
        contains: function(a, b, ignore) {
          if (ignore) {
            a = "(" + a + " || '').toLowerCase()";
            if (b) {
              b = b.toLowerCase();
            }
          }
          if (b) {
            b = quote(b);
          }
          return a + ".indexOf('" + b + "') >= 0";
        },
        doesnotcontain: function(a, b, ignore) {
          if (ignore) {
            a = "(" + a + " || '').toLowerCase()";
            if (b) {
              b = b.toLowerCase();
            }
          }
          if (b) {
            b = quote(b);
          }
          return a + ".indexOf('" + b + "') == -1";
        }
      };
    })();
    function Query(data) {
      this.data = data || [];
    }
    Query.filterExpr = function(expression) {
      var expressions = [],
          logic = {
            and: " && ",
            or: " || "
          },
          idx,
          length,
          filter,
          expr,
          fieldFunctions = [],
          operatorFunctions = [],
          field,
          operator,
          filters = expression.filters;
      for (idx = 0, length = filters.length; idx < length; idx++) {
        filter = filters[idx];
        field = filter.field;
        operator = filter.operator;
        if (filter.filters) {
          expr = Query.filterExpr(filter);
          filter = expr.expression.replace(/__o\[(\d+)\]/g, function(match, index) {
            index = +index;
            return "__o[" + (operatorFunctions.length + index) + "]";
          }).replace(/__f\[(\d+)\]/g, function(match, index) {
            index = +index;
            return "__f[" + (fieldFunctions.length + index) + "]";
          });
          operatorFunctions.push.apply(operatorFunctions, expr.operators);
          fieldFunctions.push.apply(fieldFunctions, expr.fields);
        } else {
          if (typeof field === FUNCTION) {
            expr = "__f[" + fieldFunctions.length + "](d)";
            fieldFunctions.push(field);
          } else {
            expr = kendo.expr(field);
          }
          if (typeof operator === FUNCTION) {
            filter = "__o[" + operatorFunctions.length + "](" + expr + ", " + operators.quote(filter.value) + ")";
            operatorFunctions.push(operator);
          } else {
            filter = operators[(operator || "eq").toLowerCase()](expr, filter.value, filter.ignoreCase !== undefined ? filter.ignoreCase : true);
          }
        }
        expressions.push(filter);
      }
      return {
        expression: "(" + expressions.join(logic[expression.logic]) + ")",
        fields: fieldFunctions,
        operators: operatorFunctions
      };
    };
    function normalizeSort(field, dir) {
      if (field) {
        var descriptor = typeof field === STRING ? {
          field: field,
          dir: dir
        } : field,
            descriptors = isArray(descriptor) ? descriptor : (descriptor !== undefined ? [descriptor] : []);
        return grep(descriptors, function(d) {
          return !!d.dir;
        });
      }
    }
    var operatorMap = {
      "==": "eq",
      equals: "eq",
      isequalto: "eq",
      equalto: "eq",
      equal: "eq",
      "!=": "neq",
      ne: "neq",
      notequals: "neq",
      isnotequalto: "neq",
      notequalto: "neq",
      notequal: "neq",
      "<": "lt",
      islessthan: "lt",
      lessthan: "lt",
      less: "lt",
      "<=": "lte",
      le: "lte",
      islessthanorequalto: "lte",
      lessthanequal: "lte",
      ">": "gt",
      isgreaterthan: "gt",
      greaterthan: "gt",
      greater: "gt",
      ">=": "gte",
      isgreaterthanorequalto: "gte",
      greaterthanequal: "gte",
      ge: "gte",
      notsubstringof: "doesnotcontain"
    };
    function normalizeOperator(expression) {
      var idx,
          length,
          filter,
          operator,
          filters = expression.filters;
      if (filters) {
        for (idx = 0, length = filters.length; idx < length; idx++) {
          filter = filters[idx];
          operator = filter.operator;
          if (operator && typeof operator === STRING) {
            filter.operator = operatorMap[operator.toLowerCase()] || operator;
          }
          normalizeOperator(filter);
        }
      }
    }
    function normalizeFilter(expression) {
      if (expression && !isEmptyObject(expression)) {
        if (isArray(expression) || !expression.filters) {
          expression = {
            logic: "and",
            filters: isArray(expression) ? expression : [expression]
          };
        }
        normalizeOperator(expression);
        return expression;
      }
    }
    Query.normalizeFilter = normalizeFilter;
    function normalizeAggregate(expressions) {
      return isArray(expressions) ? expressions : [expressions];
    }
    function normalizeGroup(field, dir) {
      var descriptor = typeof field === STRING ? {
        field: field,
        dir: dir
      } : field,
          descriptors = isArray(descriptor) ? descriptor : (descriptor !== undefined ? [descriptor] : []);
      return map(descriptors, function(d) {
        return {
          field: d.field,
          dir: d.dir || "asc",
          aggregates: d.aggregates
        };
      });
    }
    Query.prototype = {
      toArray: function() {
        return this.data;
      },
      range: function(index, count) {
        return new Query(this.data.slice(index, index + count));
      },
      skip: function(count) {
        return new Query(this.data.slice(count));
      },
      take: function(count) {
        return new Query(this.data.slice(0, count));
      },
      select: function(selector) {
        return new Query(map(this.data, selector));
      },
      order: function(selector, dir) {
        var sort = {dir: dir};
        if (selector) {
          if (selector.compare) {
            sort.compare = selector.compare;
          } else {
            sort.field = selector;
          }
        }
        return new Query(this.data.slice(0).sort(Comparer.create(sort)));
      },
      orderBy: function(selector) {
        return this.order(selector, "asc");
      },
      orderByDescending: function(selector) {
        return this.order(selector, "desc");
      },
      sort: function(field, dir, comparer) {
        var idx,
            length,
            descriptors = normalizeSort(field, dir),
            comparers = [];
        comparer = comparer || Comparer;
        if (descriptors.length) {
          for (idx = 0, length = descriptors.length; idx < length; idx++) {
            comparers.push(comparer.create(descriptors[idx]));
          }
          return this.orderBy({compare: comparer.combine(comparers)});
        }
        return this;
      },
      filter: function(expressions) {
        var idx,
            current,
            length,
            compiled,
            predicate,
            data = this.data,
            fields,
            operators,
            result = [],
            filter;
        expressions = normalizeFilter(expressions);
        if (!expressions || expressions.filters.length === 0) {
          return this;
        }
        compiled = Query.filterExpr(expressions);
        fields = compiled.fields;
        operators = compiled.operators;
        predicate = filter = new Function("d, __f, __o", "return " + compiled.expression);
        if (fields.length || operators.length) {
          filter = function(d) {
            return predicate(d, fields, operators);
          };
        }
        for (idx = 0, length = data.length; idx < length; idx++) {
          current = data[idx];
          if (filter(current)) {
            result.push(current);
          }
        }
        return new Query(result);
      },
      group: function(descriptors, allData) {
        descriptors = normalizeGroup(descriptors || []);
        allData = allData || this.data;
        var that = this,
            result = new Query(that.data),
            descriptor;
        if (descriptors.length > 0) {
          descriptor = descriptors[0];
          result = result.groupBy(descriptor).select(function(group) {
            var data = new Query(allData).filter([{
              field: group.field,
              operator: "eq",
              value: group.value,
              ignoreCase: false
            }]);
            return {
              field: group.field,
              value: group.value,
              items: descriptors.length > 1 ? new Query(group.items).group(descriptors.slice(1), data.toArray()).toArray() : group.items,
              hasSubgroups: descriptors.length > 1,
              aggregates: data.aggregate(descriptor.aggregates)
            };
          });
        }
        return result;
      },
      groupBy: function(descriptor) {
        if (isEmptyObject(descriptor) || !this.data.length) {
          return new Query([]);
        }
        var field = descriptor.field,
            sorted = this._sortForGrouping(field, descriptor.dir || "asc"),
            accessor = kendo.accessor(field),
            item,
            groupValue = accessor.get(sorted[0], field),
            group = {
              field: field,
              value: groupValue,
              items: []
            },
            currentValue,
            idx,
            len,
            result = [group];
        for (idx = 0, len = sorted.length; idx < len; idx++) {
          item = sorted[idx];
          currentValue = accessor.get(item, field);
          if (!groupValueComparer(groupValue, currentValue)) {
            groupValue = currentValue;
            group = {
              field: field,
              value: groupValue,
              items: []
            };
            result.push(group);
          }
          group.items.push(item);
        }
        return new Query(result);
      },
      _sortForGrouping: function(field, dir) {
        var idx,
            length,
            data = this.data;
        if (!stableSort) {
          for (idx = 0, length = data.length; idx < length; idx++) {
            data[idx].__position = idx;
          }
          data = new Query(data).sort(field, dir, StableComparer).toArray();
          for (idx = 0, length = data.length; idx < length; idx++) {
            delete data[idx].__position;
          }
          return data;
        }
        return this.sort(field, dir).toArray();
      },
      aggregate: function(aggregates) {
        var idx,
            len,
            result = {},
            state = {};
        if (aggregates && aggregates.length) {
          for (idx = 0, len = this.data.length; idx < len; idx++) {
            calculateAggregate(result, aggregates, this.data[idx], idx, len, state);
          }
        }
        return result;
      }
    };
    function groupValueComparer(a, b) {
      if (a && a.getTime && b && b.getTime) {
        return a.getTime() === b.getTime();
      }
      return a === b;
    }
    function calculateAggregate(accumulator, aggregates, item, index, length, state) {
      aggregates = aggregates || [];
      var idx,
          aggr,
          functionName,
          len = aggregates.length;
      for (idx = 0; idx < len; idx++) {
        aggr = aggregates[idx];
        functionName = aggr.aggregate;
        var field = aggr.field;
        accumulator[field] = accumulator[field] || {};
        state[field] = state[field] || {};
        state[field][functionName] = state[field][functionName] || {};
        accumulator[field][functionName] = functions[functionName.toLowerCase()](accumulator[field][functionName], item, kendo.accessor(field), index, length, state[field][functionName]);
      }
    }
    var functions = {
      sum: function(accumulator, item, accessor) {
        var value = accessor.get(item);
        if (!isNumber(accumulator)) {
          accumulator = value;
        } else if (isNumber(value)) {
          accumulator += value;
        }
        return accumulator;
      },
      count: function(accumulator) {
        return (accumulator || 0) + 1;
      },
      average: function(accumulator, item, accessor, index, length, state) {
        var value = accessor.get(item);
        if (state.count === undefined) {
          state.count = 0;
        }
        if (!isNumber(accumulator)) {
          accumulator = value;
        } else if (isNumber(value)) {
          accumulator += value;
        }
        if (isNumber(value)) {
          state.count++;
        }
        if (index == length - 1 && isNumber(accumulator)) {
          accumulator = accumulator / state.count;
        }
        return accumulator;
      },
      max: function(accumulator, item, accessor) {
        var value = accessor.get(item);
        if (!isNumber(accumulator) && !isDate(accumulator)) {
          accumulator = value;
        }
        if (accumulator < value && (isNumber(value) || isDate(value))) {
          accumulator = value;
        }
        return accumulator;
      },
      min: function(accumulator, item, accessor) {
        var value = accessor.get(item);
        if (!isNumber(accumulator) && !isDate(accumulator)) {
          accumulator = value;
        }
        if (accumulator > value && (isNumber(value) || isDate(value))) {
          accumulator = value;
        }
        return accumulator;
      }
    };
    function isNumber(val) {
      return typeof val === "number" && !isNaN(val);
    }
    function isDate(val) {
      return val && val.getTime;
    }
    function toJSON(array) {
      var idx,
          length = array.length,
          result = new Array(length);
      for (idx = 0; idx < length; idx++) {
        result[idx] = array[idx].toJSON();
      }
      return result;
    }
    Query.process = function(data, options) {
      options = options || {};
      var query = new Query(data),
          group = options.group,
          sort = normalizeGroup(group || []).concat(normalizeSort(options.sort || [])),
          total,
          filterCallback = options.filterCallback,
          filter = options.filter,
          skip = options.skip,
          take = options.take;
      if (filter) {
        query = query.filter(filter);
        if (filterCallback) {
          query = filterCallback(query);
        }
        total = query.toArray().length;
      }
      if (sort) {
        query = query.sort(sort);
        if (group) {
          data = query.toArray();
        }
      }
      if (skip !== undefined && take !== undefined) {
        query = query.range(skip, take);
      }
      if (group) {
        query = query.group(group, data);
      }
      return {
        total: total,
        data: query.toArray()
      };
    };
    var LocalTransport = Class.extend({
      init: function(options) {
        this.data = options.data;
      },
      read: function(options) {
        options.success(this.data);
      },
      update: function(options) {
        options.success(options.data);
      },
      create: function(options) {
        options.success(options.data);
      },
      destroy: function(options) {
        options.success(options.data);
      }
    });
    var RemoteTransport = Class.extend({
      init: function(options) {
        var that = this,
            parameterMap;
        options = that.options = extend({}, that.options, options);
        each(crud, function(index, type) {
          if (typeof options[type] === STRING) {
            options[type] = {url: options[type]};
          }
        });
        that.cache = options.cache ? Cache.create(options.cache) : {
          find: noop,
          add: noop
        };
        parameterMap = options.parameterMap;
        if (isFunction(options.push)) {
          that.push = options.push;
        }
        if (!that.push) {
          that.push = identity;
        }
        that.parameterMap = isFunction(parameterMap) ? parameterMap : function(options) {
          var result = {};
          each(options, function(option, value) {
            if (option in parameterMap) {
              option = parameterMap[option];
              if (isPlainObject(option)) {
                value = option.value(value);
                option = option.key;
              }
            }
            result[option] = value;
          });
          return result;
        };
      },
      options: {parameterMap: identity},
      create: function(options) {
        return ajax(this.setup(options, CREATE));
      },
      read: function(options) {
        var that = this,
            success,
            error,
            result,
            cache = that.cache;
        options = that.setup(options, READ);
        success = options.success || noop;
        error = options.error || noop;
        result = cache.find(options.data);
        if (result !== undefined) {
          success(result);
        } else {
          options.success = function(result) {
            cache.add(options.data, result);
            success(result);
          };
          $.ajax(options);
        }
      },
      update: function(options) {
        return ajax(this.setup(options, UPDATE));
      },
      destroy: function(options) {
        return ajax(this.setup(options, DESTROY));
      },
      setup: function(options, type) {
        options = options || {};
        var that = this,
            parameters,
            operation = that.options[type],
            data = isFunction(operation.data) ? operation.data(options.data) : operation.data;
        options = extend(true, {}, operation, options);
        parameters = extend(true, {}, data, options.data);
        options.data = that.parameterMap(parameters, type);
        if (isFunction(options.url)) {
          options.url = options.url(parameters);
        }
        return options;
      }
    });
    var Cache = Class.extend({
      init: function() {
        this._store = {};
      },
      add: function(key, data) {
        if (key !== undefined) {
          this._store[stringify(key)] = data;
        }
      },
      find: function(key) {
        return this._store[stringify(key)];
      },
      clear: function() {
        this._store = {};
      },
      remove: function(key) {
        delete this._store[stringify(key)];
      }
    });
    Cache.create = function(options) {
      var store = {"inmemory": function() {
          return new Cache();
        }};
      if (isPlainObject(options) && isFunction(options.find)) {
        return options;
      }
      if (options === true) {
        return new Cache();
      }
      return store[options]();
    };
    function serializeRecords(data, getters, modelInstance, originalFieldNames, fieldNames) {
      var record,
          getter,
          originalName,
          idx,
          length;
      for (idx = 0, length = data.length; idx < length; idx++) {
        record = data[idx];
        for (getter in getters) {
          originalName = fieldNames[getter];
          if (originalName && originalName !== getter) {
            record[originalName] = getters[getter](record);
            delete record[getter];
          }
        }
      }
    }
    function convertRecords(data, getters, modelInstance, originalFieldNames, fieldNames) {
      var record,
          getter,
          originalName,
          idx,
          length;
      for (idx = 0, length = data.length; idx < length; idx++) {
        record = data[idx];
        for (getter in getters) {
          record[getter] = modelInstance._parse(getter, getters[getter](record));
          originalName = fieldNames[getter];
          if (originalName && originalName !== getter) {
            delete record[originalName];
          }
        }
      }
    }
    function convertGroup(data, getters, modelInstance, originalFieldNames, fieldNames) {
      var record,
          idx,
          fieldName,
          length;
      for (idx = 0, length = data.length; idx < length; idx++) {
        record = data[idx];
        fieldName = originalFieldNames[record.field];
        if (fieldName && fieldName != record.field) {
          record.field = fieldName;
        }
        record.value = modelInstance._parse(record.field, record.value);
        if (record.hasSubgroups) {
          convertGroup(record.items, getters, modelInstance, originalFieldNames, fieldNames);
        } else {
          convertRecords(record.items, getters, modelInstance, originalFieldNames, fieldNames);
        }
      }
    }
    function wrapDataAccess(originalFunction, model, converter, getters, originalFieldNames, fieldNames) {
      return function(data) {
        data = originalFunction(data);
        if (data && !isEmptyObject(getters)) {
          if (toString.call(data) !== "[object Array]" && !(data instanceof ObservableArray)) {
            data = [data];
          }
          converter(data, getters, new model(), originalFieldNames, fieldNames);
        }
        return data || [];
      };
    }
    var DataReader = Class.extend({
      init: function(schema) {
        var that = this,
            member,
            get,
            model,
            base;
        schema = schema || {};
        for (member in schema) {
          get = schema[member];
          that[member] = typeof get === STRING ? getter(get) : get;
        }
        base = schema.modelBase || Model;
        if (isPlainObject(that.model)) {
          that.model = model = base.define(that.model);
        }
        var dataFunction = proxy(that.data, that);
        that._dataAccessFunction = dataFunction;
        if (that.model) {
          var groupsFunction = proxy(that.groups, that),
              serializeFunction = proxy(that.serialize, that),
              originalFieldNames = {},
              getters = {},
              serializeGetters = {},
              fieldNames = {},
              shouldSerialize = false,
              fieldName;
          model = that.model;
          if (model.fields) {
            each(model.fields, function(field, value) {
              var fromName;
              fieldName = field;
              if (isPlainObject(value) && value.field) {
                fieldName = value.field;
              } else if (typeof value === STRING) {
                fieldName = value;
              }
              if (isPlainObject(value) && value.from) {
                fromName = value.from;
              }
              shouldSerialize = shouldSerialize || (fromName && fromName !== field) || fieldName !== field;
              getters[field] = getter(fromName || fieldName);
              serializeGetters[field] = getter(field);
              originalFieldNames[fromName || fieldName] = field;
              fieldNames[field] = fromName || fieldName;
            });
            if (!schema.serialize && shouldSerialize) {
              that.serialize = wrapDataAccess(serializeFunction, model, serializeRecords, serializeGetters, originalFieldNames, fieldNames);
            }
          }
          that._dataAccessFunction = dataFunction;
          that.data = wrapDataAccess(dataFunction, model, convertRecords, getters, originalFieldNames, fieldNames);
          that.groups = wrapDataAccess(groupsFunction, model, convertGroup, getters, originalFieldNames, fieldNames);
        }
      },
      errors: function(data) {
        return data ? data.errors : null;
      },
      parse: identity,
      data: identity,
      total: function(data) {
        return data.length;
      },
      groups: identity,
      aggregates: function() {
        return {};
      },
      serialize: function(data) {
        return data;
      }
    });
    function mergeGroups(target, dest, skip, take) {
      var group,
          idx = 0,
          items;
      while (dest.length && take) {
        group = dest[idx];
        items = group.items;
        var length = items.length;
        if (target && target.field === group.field && target.value === group.value) {
          if (target.hasSubgroups && target.items.length) {
            mergeGroups(target.items[target.items.length - 1], group.items, skip, take);
          } else {
            items = items.slice(skip, skip + take);
            target.items = target.items.concat(items);
          }
          dest.splice(idx--, 1);
        } else if (group.hasSubgroups && items.length) {
          mergeGroups(group, items, skip, take);
          if (!group.items.length) {
            dest.splice(idx--, 1);
          }
        } else {
          items = items.slice(skip, skip + take);
          group.items = items;
          if (!group.items.length) {
            dest.splice(idx--, 1);
          }
        }
        if (items.length === 0) {
          skip -= length;
        } else {
          skip = 0;
          take -= items.length;
        }
        if (++idx >= dest.length) {
          break;
        }
      }
      if (idx < dest.length) {
        dest.splice(idx, dest.length - idx);
      }
    }
    function flattenGroups(data) {
      var idx,
          result = [],
          length,
          items,
          itemIndex;
      for (idx = 0, length = data.length; idx < length; idx++) {
        var group = data.at(idx);
        if (group.hasSubgroups) {
          result = result.concat(flattenGroups(group.items));
        } else {
          items = group.items;
          for (itemIndex = 0; itemIndex < items.length; itemIndex++) {
            result.push(items.at(itemIndex));
          }
        }
      }
      return result;
    }
    function wrapGroupItems(data, model) {
      var idx,
          length,
          group,
          items;
      if (model) {
        for (idx = 0, length = data.length; idx < length; idx++) {
          group = data.at(idx);
          if (group.hasSubgroups) {
            wrapGroupItems(group.items, model);
          } else {
            group.items = new LazyObservableArray(group.items, model);
          }
        }
      }
    }
    function eachGroupItems(data, func) {
      for (var idx = 0,
          length = data.length; idx < length; idx++) {
        if (data[idx].hasSubgroups) {
          if (eachGroupItems(data[idx].items, func)) {
            return true;
          }
        } else if (func(data[idx].items, data[idx])) {
          return true;
        }
      }
    }
    function replaceInRanges(ranges, data, item, observable) {
      for (var idx = 0; idx < ranges.length; idx++) {
        if (ranges[idx].data === data) {
          break;
        }
        if (replaceInRange(ranges[idx].data, item, observable)) {
          break;
        }
      }
    }
    function replaceInRange(items, item, observable) {
      for (var idx = 0,
          length = items.length; idx < length; idx++) {
        if (items[idx] && items[idx].hasSubgroups) {
          return replaceInRange(items[idx].items, item, observable);
        } else if (items[idx] === item || items[idx] === observable) {
          items[idx] = observable;
          return true;
        }
      }
    }
    function replaceWithObservable(view, data, ranges, type, serverGrouping) {
      for (var viewIndex = 0,
          length = view.length; viewIndex < length; viewIndex++) {
        var item = view[viewIndex];
        if (!item || item instanceof type) {
          continue;
        }
        if (item.hasSubgroups !== undefined && !serverGrouping) {
          replaceWithObservable(item.items, data, ranges, type, serverGrouping);
        } else {
          for (var idx = 0; idx < data.length; idx++) {
            if (data[idx] === item) {
              view[viewIndex] = data.at(idx);
              replaceInRanges(ranges, data, item, view[viewIndex]);
              break;
            }
          }
        }
      }
    }
    function removeModel(data, model) {
      var idx,
          length;
      for (idx = 0, length = data.length; idx < length; idx++) {
        var dataItem = data.at(idx);
        if (dataItem.uid == model.uid) {
          data.splice(idx, 1);
          return dataItem;
        }
      }
    }
    function indexOfPristineModel(data, model) {
      if (model) {
        return indexOf(data, function(item) {
          return (item.uid && item.uid == model.uid) || (item[model.idField] === model.id && model.id !== model._defaultId);
        });
      }
      return -1;
    }
    function indexOfModel(data, model) {
      if (model) {
        return indexOf(data, function(item) {
          return item.uid == model.uid;
        });
      }
      return -1;
    }
    function indexOf(data, comparer) {
      var idx,
          length;
      for (idx = 0, length = data.length; idx < length; idx++) {
        if (comparer(data[idx])) {
          return idx;
        }
      }
      return -1;
    }
    function fieldNameFromModel(fields, name) {
      if (fields && !isEmptyObject(fields)) {
        var descriptor = fields[name];
        var fieldName;
        if (isPlainObject(descriptor)) {
          fieldName = descriptor.from || descriptor.field || name;
        } else {
          fieldName = fields[name] || name;
        }
        if (isFunction(fieldName)) {
          return name;
        }
        return fieldName;
      }
      return name;
    }
    function convertFilterDescriptorsField(descriptor, model) {
      var idx,
          length,
          target = {};
      for (var field in descriptor) {
        if (field !== "filters") {
          target[field] = descriptor[field];
        }
      }
      if (descriptor.filters) {
        target.filters = [];
        for (idx = 0, length = descriptor.filters.length; idx < length; idx++) {
          target.filters[idx] = convertFilterDescriptorsField(descriptor.filters[idx], model);
        }
      } else {
        target.field = fieldNameFromModel(model.fields, target.field);
      }
      return target;
    }
    function convertDescriptorsField(descriptors, model) {
      var idx,
          length,
          result = [],
          target,
          descriptor;
      for (idx = 0, length = descriptors.length; idx < length; idx++) {
        target = {};
        descriptor = descriptors[idx];
        for (var field in descriptor) {
          target[field] = descriptor[field];
        }
        target.field = fieldNameFromModel(model.fields, target.field);
        if (target.aggregates && isArray(target.aggregates)) {
          target.aggregates = convertDescriptorsField(target.aggregates, model);
        }
        result.push(target);
      }
      return result;
    }
    var DataSource = Observable.extend({
      init: function(options) {
        var that = this,
            model,
            data;
        if (options) {
          data = options.data;
        }
        options = that.options = extend({}, that.options, options);
        that._map = {};
        that._prefetch = {};
        that._data = [];
        that._pristineData = [];
        that._ranges = [];
        that._view = [];
        that._pristineTotal = 0;
        that._destroyed = [];
        that._pageSize = options.pageSize;
        that._page = options.page || (options.pageSize ? 1 : undefined);
        that._sort = normalizeSort(options.sort);
        that._filter = normalizeFilter(options.filter);
        that._group = normalizeGroup(options.group);
        that._aggregate = options.aggregate;
        that._total = options.total;
        that._shouldDetachObservableParents = true;
        Observable.fn.init.call(that);
        that.transport = Transport.create(options, data, that);
        if (isFunction(that.transport.push)) {
          that.transport.push({
            pushCreate: proxy(that._pushCreate, that),
            pushUpdate: proxy(that._pushUpdate, that),
            pushDestroy: proxy(that._pushDestroy, that)
          });
        }
        if (options.offlineStorage != null) {
          if (typeof options.offlineStorage == "string") {
            var key = options.offlineStorage;
            that._storage = {
              getItem: function() {
                return JSON.parse(localStorage.getItem(key));
              },
              setItem: function(item) {
                localStorage.setItem(key, stringify(that.reader.serialize(item)));
              }
            };
          } else {
            that._storage = options.offlineStorage;
          }
        }
        that.reader = new kendo.data.readers[options.schema.type || "json"](options.schema);
        model = that.reader.model || {};
        that._detachObservableParents();
        that._data = that._observe(that._data);
        that._online = true;
        that.bind(["push", ERROR, CHANGE, REQUESTSTART, SYNC, REQUESTEND, PROGRESS], options);
      },
      options: {
        data: null,
        schema: {modelBase: Model},
        offlineStorage: null,
        serverSorting: false,
        serverPaging: false,
        serverFiltering: false,
        serverGrouping: false,
        serverAggregates: false,
        batch: false
      },
      clone: function() {
        return this;
      },
      online: function(value) {
        if (value !== undefined) {
          if (this._online != value) {
            this._online = value;
            if (value) {
              return this.sync();
            }
          }
          return $.Deferred().resolve().promise();
        } else {
          return this._online;
        }
      },
      offlineData: function(state) {
        if (this.options.offlineStorage == null) {
          return null;
        }
        if (state !== undefined) {
          return this._storage.setItem(state);
        }
        return this._storage.getItem() || [];
      },
      _isServerGrouped: function() {
        var group = this.group() || [];
        return this.options.serverGrouping && group.length;
      },
      _pushCreate: function(result) {
        this._push(result, "pushCreate");
      },
      _pushUpdate: function(result) {
        this._push(result, "pushUpdate");
      },
      _pushDestroy: function(result) {
        this._push(result, "pushDestroy");
      },
      _push: function(result, operation) {
        var data = this._readData(result);
        if (!data) {
          data = result;
        }
        this[operation](data);
      },
      _flatData: function(data, skip) {
        if (data) {
          if (this._isServerGrouped()) {
            return flattenGroups(data);
          }
          if (!skip) {
            for (var idx = 0; idx < data.length; idx++) {
              data.at(idx);
            }
          }
        }
        return data;
      },
      parent: noop,
      get: function(id) {
        var idx,
            length,
            data = this._flatData(this._data);
        for (idx = 0, length = data.length; idx < length; idx++) {
          if (data[idx].id == id) {
            return data[idx];
          }
        }
      },
      getByUid: function(id) {
        var idx,
            length,
            data = this._flatData(this._data);
        if (!data) {
          return ;
        }
        for (idx = 0, length = data.length; idx < length; idx++) {
          if (data[idx].uid == id) {
            return data[idx];
          }
        }
      },
      indexOf: function(model) {
        return indexOfModel(this._data, model);
      },
      at: function(index) {
        return this._data.at(index);
      },
      data: function(value) {
        var that = this;
        if (value !== undefined) {
          that._detachObservableParents();
          that._data = this._observe(value);
          that._pristineData = value.slice(0);
          that._storeData();
          that._ranges = [];
          that.trigger("reset");
          that._addRange(that._data);
          that._total = that._data.length;
          that._pristineTotal = that._total;
          that._process(that._data);
        } else {
          if (that._data) {
            for (var idx = 0; idx < that._data.length; idx++) {
              that._data.at(idx);
            }
          }
          return that._data;
        }
      },
      view: function(value) {
        if (value === undefined) {
          return this._view;
        } else {
          this._view = this._observeView(value);
        }
      },
      _observeView: function(data) {
        var that = this;
        replaceWithObservable(data, that._data, that._ranges, that.reader.model || ObservableObject, that._isServerGrouped());
        var view = new LazyObservableArray(data, that.reader.model);
        view.parent = function() {
          return that.parent();
        };
        return view;
      },
      flatView: function() {
        var groups = this.group() || [];
        if (groups.length) {
          return flattenGroups(this._view);
        } else {
          return this._view;
        }
      },
      add: function(model) {
        return this.insert(this._data.length, model);
      },
      _createNewModel: function(model) {
        if (this.reader.model) {
          return new this.reader.model(model);
        }
        if (model instanceof ObservableObject) {
          return model;
        }
        return new ObservableObject(model);
      },
      insert: function(index, model) {
        if (!model) {
          model = index;
          index = 0;
        }
        if (!(model instanceof Model)) {
          model = this._createNewModel(model);
        }
        if (this._isServerGrouped()) {
          this._data.splice(index, 0, this._wrapInEmptyGroup(model));
        } else {
          this._data.splice(index, 0, model);
        }
        return model;
      },
      pushCreate: function(items) {
        if (!isArray(items)) {
          items = [items];
        }
        var pushed = [];
        var autoSync = this.options.autoSync;
        this.options.autoSync = false;
        try {
          for (var idx = 0; idx < items.length; idx++) {
            var item = items[idx];
            var result = this.add(item);
            pushed.push(result);
            var pristine = result.toJSON();
            if (this._isServerGrouped()) {
              pristine = this._wrapInEmptyGroup(pristine);
            }
            this._pristineData.push(pristine);
          }
        } finally {
          this.options.autoSync = autoSync;
        }
        if (pushed.length) {
          this.trigger("push", {
            type: "create",
            items: pushed
          });
        }
      },
      pushUpdate: function(items) {
        if (!isArray(items)) {
          items = [items];
        }
        var pushed = [];
        for (var idx = 0; idx < items.length; idx++) {
          var item = items[idx];
          var model = this._createNewModel(item);
          var target = this.get(model.id);
          if (target) {
            pushed.push(target);
            target.accept(item);
            target.trigger(CHANGE);
            this._updatePristineForModel(target, item);
          } else {
            this.pushCreate(item);
          }
        }
        if (pushed.length) {
          this.trigger("push", {
            type: "update",
            items: pushed
          });
        }
      },
      pushDestroy: function(items) {
        var pushed = this._removeItems(items);
        if (pushed.length) {
          this.trigger("push", {
            type: "destroy",
            items: pushed
          });
        }
      },
      _removeItems: function(items) {
        if (!isArray(items)) {
          items = [items];
        }
        var destroyed = [];
        var autoSync = this.options.autoSync;
        this.options.autoSync = false;
        try {
          for (var idx = 0; idx < items.length; idx++) {
            var item = items[idx];
            var model = this._createNewModel(item);
            var found = false;
            this._eachItem(this._data, function(items) {
              for (var idx = 0; idx < items.length; idx++) {
                var item = items.at(idx);
                if (item.id === model.id) {
                  destroyed.push(item);
                  items.splice(idx, 1);
                  found = true;
                  break;
                }
              }
            });
            if (found) {
              this._removePristineForModel(model);
              this._destroyed.pop();
            }
          }
        } finally {
          this.options.autoSync = autoSync;
        }
        return destroyed;
      },
      remove: function(model) {
        var result,
            that = this,
            hasGroups = that._isServerGrouped();
        this._eachItem(that._data, function(items) {
          result = removeModel(items, model);
          if (result && hasGroups) {
            if (!result.isNew || !result.isNew()) {
              that._destroyed.push(result);
            }
            return true;
          }
        });
        this._removeModelFromRanges(model);
        this._updateRangesLength();
        return model;
      },
      destroyed: function() {
        return this._destroyed;
      },
      created: function() {
        var idx,
            length,
            result = [],
            data = this._flatData(this._data);
        for (idx = 0, length = data.length; idx < length; idx++) {
          if (data[idx].isNew && data[idx].isNew()) {
            result.push(data[idx]);
          }
        }
        return result;
      },
      updated: function() {
        var idx,
            length,
            result = [],
            data = this._flatData(this._data);
        for (idx = 0, length = data.length; idx < length; idx++) {
          if ((data[idx].isNew && !data[idx].isNew()) && data[idx].dirty) {
            result.push(data[idx]);
          }
        }
        return result;
      },
      sync: function() {
        var that = this,
            idx,
            length,
            created = [],
            updated = [],
            destroyed = that._destroyed,
            data = that._flatData(that._data);
        var promise = $.Deferred().resolve().promise();
        if (that.online()) {
          if (!that.reader.model) {
            return promise;
          }
          created = that.created();
          updated = that.updated();
          var promises = [];
          if (that.options.batch && that.transport.submit) {
            promises = that._sendSubmit(created, updated, destroyed);
          } else {
            promises.push.apply(promises, that._send("create", created));
            promises.push.apply(promises, that._send("update", updated));
            promises.push.apply(promises, that._send("destroy", destroyed));
          }
          promise = $.when.apply(null, promises).then(function() {
            var idx,
                length;
            for (idx = 0, length = arguments.length; idx < length; idx++) {
              that._accept(arguments[idx]);
            }
            that._storeData(true);
            that._change({action: "sync"});
            that.trigger(SYNC);
          });
        } else {
          that._storeData(true);
          that._change({action: "sync"});
        }
        return promise;
      },
      cancelChanges: function(model) {
        var that = this;
        if (model instanceof kendo.data.Model) {
          that._cancelModel(model);
        } else {
          that._destroyed = [];
          that._detachObservableParents();
          that._data = that._observe(that._pristineData);
          if (that.options.serverPaging) {
            that._total = that._pristineTotal;
          }
          that._ranges = [];
          that._addRange(that._data);
          that._change();
        }
      },
      hasChanges: function() {
        var idx,
            length,
            data = this._flatData(this._data);
        if (this._destroyed.length) {
          return true;
        }
        for (idx = 0, length = data.length; idx < length; idx++) {
          if ((data[idx].isNew && data[idx].isNew()) || data[idx].dirty) {
            return true;
          }
        }
        return false;
      },
      _accept: function(result) {
        var that = this,
            models = result.models,
            response = result.response,
            idx = 0,
            serverGroup = that._isServerGrouped(),
            pristine = that._pristineData,
            type = result.type,
            length;
        that.trigger(REQUESTEND, {
          response: response,
          type: type
        });
        if (response && !isEmptyObject(response)) {
          response = that.reader.parse(response);
          if (that._handleCustomErrors(response)) {
            return ;
          }
          response = that.reader.data(response);
          if (!isArray(response)) {
            response = [response];
          }
        } else {
          response = $.map(models, function(model) {
            return model.toJSON();
          });
        }
        if (type === "destroy") {
          that._destroyed = [];
        }
        for (idx = 0, length = models.length; idx < length; idx++) {
          if (type !== "destroy") {
            models[idx].accept(response[idx]);
            if (type === "create") {
              pristine.push(serverGroup ? that._wrapInEmptyGroup(models[idx]) : response[idx]);
            } else if (type === "update") {
              that._updatePristineForModel(models[idx], response[idx]);
            }
          } else {
            that._removePristineForModel(models[idx]);
          }
        }
      },
      _updatePristineForModel: function(model, values) {
        this._executeOnPristineForModel(model, function(index, items) {
          kendo.deepExtend(items[index], values);
        });
      },
      _executeOnPristineForModel: function(model, callback) {
        this._eachPristineItem(function(items) {
          var index = indexOfPristineModel(items, model);
          if (index > -1) {
            callback(index, items);
            return true;
          }
        });
      },
      _removePristineForModel: function(model) {
        this._executeOnPristineForModel(model, function(index, items) {
          items.splice(index, 1);
        });
      },
      _readData: function(data) {
        var read = !this._isServerGrouped() ? this.reader.data : this.reader.groups;
        return read.call(this.reader, data);
      },
      _eachPristineItem: function(callback) {
        this._eachItem(this._pristineData, callback);
      },
      _eachItem: function(data, callback) {
        if (data && data.length) {
          if (this._isServerGrouped()) {
            eachGroupItems(data, callback);
          } else {
            callback(data);
          }
        }
      },
      _pristineForModel: function(model) {
        var pristine,
            idx,
            callback = function(items) {
              idx = indexOfPristineModel(items, model);
              if (idx > -1) {
                pristine = items[idx];
                return true;
              }
            };
        this._eachPristineItem(callback);
        return pristine;
      },
      _cancelModel: function(model) {
        var pristine = this._pristineForModel(model);
        this._eachItem(this._data, function(items) {
          var idx = indexOfModel(items, model);
          if (idx >= 0) {
            if (pristine && (!model.isNew() || pristine.__state__)) {
              items[idx].accept(pristine);
            } else {
              items.splice(idx, 1);
            }
          }
        });
      },
      _submit: function(promises, data) {
        var that = this;
        that.trigger(REQUESTSTART, {type: "submit"});
        that.transport.submit(extend({
          success: function(response, type) {
            var promise = $.grep(promises, function(x) {
              return x.type == type;
            })[0];
            if (promise) {
              promise.resolve({
                response: response,
                models: promise.models,
                type: type
              });
            }
          },
          error: function(response, status, error) {
            for (var idx = 0; idx < promises.length; idx++) {
              promises[idx].reject(response);
            }
            that.error(response, status, error);
          }
        }, data));
      },
      _sendSubmit: function(created, updated, destroyed) {
        var that = this,
            promises = [];
        if (that.options.batch) {
          if (created.length) {
            promises.push($.Deferred(function(deferred) {
              deferred.type = "create";
              deferred.models = created;
            }));
          }
          if (updated.length) {
            promises.push($.Deferred(function(deferred) {
              deferred.type = "update";
              deferred.models = updated;
            }));
          }
          if (destroyed.length) {
            promises.push($.Deferred(function(deferred) {
              deferred.type = "destroy";
              deferred.models = destroyed;
            }));
          }
          that._submit(promises, {data: {
              created: that.reader.serialize(toJSON(created)),
              updated: that.reader.serialize(toJSON(updated)),
              destroyed: that.reader.serialize(toJSON(destroyed))
            }});
        }
        return promises;
      },
      _promise: function(data, models, type) {
        var that = this;
        return $.Deferred(function(deferred) {
          that.trigger(REQUESTSTART, {type: type});
          that.transport[type].call(that.transport, extend({
            success: function(response) {
              deferred.resolve({
                response: response,
                models: models,
                type: type
              });
            },
            error: function(response, status, error) {
              deferred.reject(response);
              that.error(response, status, error);
            }
          }, data));
        }).promise();
      },
      _send: function(method, data) {
        var that = this,
            idx,
            length,
            promises = [],
            converted = that.reader.serialize(toJSON(data));
        if (that.options.batch) {
          if (data.length) {
            promises.push(that._promise({data: {models: converted}}, data, method));
          }
        } else {
          for (idx = 0, length = data.length; idx < length; idx++) {
            promises.push(that._promise({data: converted[idx]}, [data[idx]], method));
          }
        }
        return promises;
      },
      read: function(data) {
        var that = this,
            params = that._params(data);
        var deferred = $.Deferred();
        that._queueRequest(params, function() {
          var isPrevented = that.trigger(REQUESTSTART, {type: "read"});
          if (!isPrevented) {
            that.trigger(PROGRESS);
            that._ranges = [];
            that.trigger("reset");
            if (that.online()) {
              that.transport.read({
                data: params,
                success: function(data) {
                  that.success(data, params);
                  deferred.resolve();
                },
                error: function() {
                  var args = slice.call(arguments);
                  that.error.apply(that, args);
                  deferred.reject.apply(deferred, args);
                }
              });
            } else if (that.options.offlineStorage != null) {
              that.success(that.offlineData(), params);
              deferred.resolve();
            }
          } else {
            that._dequeueRequest();
            deferred.resolve(isPrevented);
          }
        });
        return deferred.promise();
      },
      _readAggregates: function(data) {
        return this.reader.aggregates(data);
      },
      success: function(data) {
        var that = this,
            options = that.options;
        that.trigger(REQUESTEND, {
          response: data,
          type: "read"
        });
        if (that.online()) {
          data = that.reader.parse(data);
          if (that._handleCustomErrors(data)) {
            that._dequeueRequest();
            return ;
          }
          that._total = that.reader.total(data);
          if (that._aggregate && options.serverAggregates) {
            that._aggregateResult = that._readAggregates(data);
          }
          data = that._readData(data);
        } else {
          data = that._readData(data);
          var items = [];
          var itemIds = {};
          var model = that.reader.model;
          var idField = model ? model.idField : "id";
          var idx;
          for (idx = 0; idx < this._destroyed.length; idx++) {
            var id = this._destroyed[idx][idField];
            itemIds[id] = id;
          }
          for (idx = 0; idx < data.length; idx++) {
            var item = data[idx];
            var state = item.__state__;
            if (state == "destroy") {
              if (!itemIds[item[idField]]) {
                this._destroyed.push(this._createNewModel(item));
              }
            } else {
              items.push(item);
            }
          }
          data = items;
          that._total = data.length;
        }
        that._pristineTotal = that._total;
        that._pristineData = data.slice(0);
        that._detachObservableParents();
        that._data = that._observe(data);
        if (that.options.offlineStorage != null) {
          that._eachItem(that._data, function(items) {
            for (var idx = 0; idx < items.length; idx++) {
              var item = items.at(idx);
              if (item.__state__ == "update") {
                item.dirty = true;
              }
            }
          });
        }
        that._storeData();
        that._addRange(that._data);
        that._process(that._data);
        that._dequeueRequest();
      },
      _detachObservableParents: function() {
        if (this._data && this._shouldDetachObservableParents) {
          for (var idx = 0; idx < this._data.length; idx++) {
            if (this._data[idx].parent) {
              this._data[idx].parent = noop;
            }
          }
        }
      },
      _storeData: function(updatePristine) {
        var serverGrouping = this._isServerGrouped();
        var model = this.reader.model;
        function items(data) {
          var state = [];
          for (var idx = 0; idx < data.length; idx++) {
            var dataItem = data.at(idx);
            var item = dataItem.toJSON();
            if (serverGrouping && dataItem.items) {
              item.items = items(dataItem.items);
            } else {
              item.uid = dataItem.uid;
              if (model) {
                if (dataItem.isNew()) {
                  item.__state__ = "create";
                } else if (dataItem.dirty) {
                  item.__state__ = "update";
                }
              }
            }
            state.push(item);
          }
          return state;
        }
        if (this.options.offlineStorage != null) {
          var state = items(this._data);
          for (var idx = 0; idx < this._destroyed.length; idx++) {
            var item = this._destroyed[idx].toJSON();
            item.__state__ = "destroy";
            state.push(item);
          }
          this.offlineData(state);
          if (updatePristine) {
            this._pristineData = state;
          }
        }
      },
      _addRange: function(data) {
        var that = this,
            start = that._skip || 0,
            end = start + that._flatData(data, true).length;
        that._ranges.push({
          start: start,
          end: end,
          data: data,
          timestamp: new Date().getTime()
        });
        that._ranges.sort(function(x, y) {
          return x.start - y.start;
        });
      },
      error: function(xhr, status, errorThrown) {
        this._dequeueRequest();
        this.trigger(REQUESTEND, {});
        this.trigger(ERROR, {
          xhr: xhr,
          status: status,
          errorThrown: errorThrown
        });
      },
      _params: function(data) {
        var that = this,
            options = extend({
              take: that.take(),
              skip: that.skip(),
              page: that.page(),
              pageSize: that.pageSize(),
              sort: that._sort,
              filter: that._filter,
              group: that._group,
              aggregate: that._aggregate
            }, data);
        if (!that.options.serverPaging) {
          delete options.take;
          delete options.skip;
          delete options.page;
          delete options.pageSize;
        }
        if (!that.options.serverGrouping) {
          delete options.group;
        } else if (that.reader.model && options.group) {
          options.group = convertDescriptorsField(options.group, that.reader.model);
        }
        if (!that.options.serverFiltering) {
          delete options.filter;
        } else if (that.reader.model && options.filter) {
          options.filter = convertFilterDescriptorsField(options.filter, that.reader.model);
        }
        if (!that.options.serverSorting) {
          delete options.sort;
        } else if (that.reader.model && options.sort) {
          options.sort = convertDescriptorsField(options.sort, that.reader.model);
        }
        if (!that.options.serverAggregates) {
          delete options.aggregate;
        } else if (that.reader.model && options.aggregate) {
          options.aggregate = convertDescriptorsField(options.aggregate, that.reader.model);
        }
        return options;
      },
      _queueRequest: function(options, callback) {
        var that = this;
        if (!that._requestInProgress) {
          that._requestInProgress = true;
          that._pending = undefined;
          callback();
        } else {
          that._pending = {
            callback: proxy(callback, that),
            options: options
          };
        }
      },
      _dequeueRequest: function() {
        var that = this;
        that._requestInProgress = false;
        if (that._pending) {
          that._queueRequest(that._pending.options, that._pending.callback);
        }
      },
      _handleCustomErrors: function(response) {
        if (this.reader.errors) {
          var errors = this.reader.errors(response);
          if (errors) {
            this.trigger(ERROR, {
              xhr: null,
              status: "customerror",
              errorThrown: "custom error",
              errors: errors
            });
            return true;
          }
        }
        return false;
      },
      _shouldWrap: function(data) {
        var model = this.reader.model;
        if (model && data.length) {
          return !(data[0] instanceof model);
        }
        return false;
      },
      _observe: function(data) {
        var that = this,
            model = that.reader.model,
            wrap = false;
        that._shouldDetachObservableParents = true;
        if (data instanceof ObservableArray) {
          that._shouldDetachObservableParents = false;
          if (that._shouldWrap(data)) {
            data.type = that.reader.model;
            data.wrapAll(data, data);
          }
        } else {
          var arrayType = that.pageSize() && !that.options.serverPaging ? LazyObservableArray : ObservableArray;
          data = new arrayType(data, that.reader.model);
          data.parent = function() {
            return that.parent();
          };
        }
        if (that._isServerGrouped()) {
          wrapGroupItems(data, model);
        }
        if (that._changeHandler && that._data && that._data instanceof ObservableArray) {
          that._data.unbind(CHANGE, that._changeHandler);
        } else {
          that._changeHandler = proxy(that._change, that);
        }
        return data.bind(CHANGE, that._changeHandler);
      },
      _change: function(e) {
        var that = this,
            idx,
            length,
            action = e ? e.action : "";
        if (action === "remove") {
          for (idx = 0, length = e.items.length; idx < length; idx++) {
            if (!e.items[idx].isNew || !e.items[idx].isNew()) {
              that._destroyed.push(e.items[idx]);
            }
          }
        }
        if (that.options.autoSync && (action === "add" || action === "remove" || action === "itemchange")) {
          that.sync();
        } else {
          var total = parseInt(that._total, 10);
          if (!isNumber(that._total)) {
            total = parseInt(that._pristineTotal, 10);
          }
          if (action === "add") {
            total += e.items.length;
          } else if (action === "remove") {
            total -= e.items.length;
          } else if (action !== "itemchange" && action !== "sync" && !that.options.serverPaging) {
            total = that._pristineTotal;
          } else if (action === "sync") {
            total = that._pristineTotal = parseInt(that._total, 10);
          }
          that._total = total;
          that._process(that._data, e);
        }
      },
      _calculateAggregates: function(data, options) {
        options = options || {};
        var query = new Query(data),
            aggregates = options.aggregate,
            filter = options.filter;
        if (filter) {
          query = query.filter(filter);
        }
        return query.aggregate(aggregates);
      },
      _process: function(data, e) {
        var that = this,
            options = {},
            result;
        if (that.options.serverPaging !== true) {
          options.skip = that._skip;
          options.take = that._take || that._pageSize;
          if (options.skip === undefined && that._page !== undefined && that._pageSize !== undefined) {
            options.skip = (that._page - 1) * that._pageSize;
          }
        }
        if (that.options.serverSorting !== true) {
          options.sort = that._sort;
        }
        if (that.options.serverFiltering !== true) {
          options.filter = that._filter;
        }
        if (that.options.serverGrouping !== true) {
          options.group = that._group;
        }
        if (that.options.serverAggregates !== true) {
          options.aggregate = that._aggregate;
          that._aggregateResult = that._calculateAggregates(data, options);
        }
        result = that._queryProcess(data, options);
        that.view(result.data);
        if (result.total !== undefined && !that.options.serverFiltering) {
          that._total = result.total;
        }
        e = e || {};
        e.items = e.items || that._view;
        that.trigger(CHANGE, e);
      },
      _queryProcess: function(data, options) {
        return Query.process(data, options);
      },
      _mergeState: function(options) {
        var that = this;
        if (options !== undefined) {
          that._pageSize = options.pageSize;
          that._page = options.page;
          that._sort = options.sort;
          that._filter = options.filter;
          that._group = options.group;
          that._aggregate = options.aggregate;
          that._skip = options.skip;
          that._take = options.take;
          if (that._skip === undefined) {
            that._skip = that.skip();
            options.skip = that.skip();
          }
          if (that._take === undefined && that._pageSize !== undefined) {
            that._take = that._pageSize;
            options.take = that._take;
          }
          if (options.sort) {
            that._sort = options.sort = normalizeSort(options.sort);
          }
          if (options.filter) {
            that._filter = options.filter = normalizeFilter(options.filter);
          }
          if (options.group) {
            that._group = options.group = normalizeGroup(options.group);
          }
          if (options.aggregate) {
            that._aggregate = options.aggregate = normalizeAggregate(options.aggregate);
          }
        }
        return options;
      },
      query: function(options) {
        var result;
        var remote = this.options.serverSorting || this.options.serverPaging || this.options.serverFiltering || this.options.serverGrouping || this.options.serverAggregates;
        if (remote || ((this._data === undefined || this._data.length === 0) && !this._destroyed.length)) {
          return this.read(this._mergeState(options));
        }
        var isPrevented = this.trigger(REQUESTSTART, {type: "read"});
        if (!isPrevented) {
          this.trigger(PROGRESS);
          result = this._queryProcess(this._data, this._mergeState(options));
          if (!this.options.serverFiltering) {
            if (result.total !== undefined) {
              this._total = result.total;
            } else {
              this._total = this._data.length;
            }
          }
          this._aggregateResult = this._calculateAggregates(this._data, options);
          this.view(result.data);
          this.trigger(REQUESTEND, {type: "read"});
          this.trigger(CHANGE, {items: result.data});
        }
        return $.Deferred().resolve(isPrevented).promise();
      },
      fetch: function(callback) {
        var that = this;
        var fn = function(isPrevented) {
          if (isPrevented !== true && isFunction(callback)) {
            callback.call(that);
          }
        };
        return this._query().then(fn);
      },
      _query: function(options) {
        var that = this;
        return that.query(extend({}, {
          page: that.page(),
          pageSize: that.pageSize(),
          sort: that.sort(),
          filter: that.filter(),
          group: that.group(),
          aggregate: that.aggregate()
        }, options));
      },
      next: function(options) {
        var that = this,
            page = that.page(),
            total = that.total();
        options = options || {};
        if (!page || (total && page + 1 > that.totalPages())) {
          return ;
        }
        that._skip = page * that.take();
        page += 1;
        options.page = page;
        that._query(options);
        return page;
      },
      prev: function(options) {
        var that = this,
            page = that.page();
        options = options || {};
        if (!page || page === 1) {
          return ;
        }
        that._skip = that._skip - that.take();
        page -= 1;
        options.page = page;
        that._query(options);
        return page;
      },
      page: function(val) {
        var that = this,
            skip;
        if (val !== undefined) {
          val = math.max(math.min(math.max(val, 1), that.totalPages()), 1);
          that._query({page: val});
          return ;
        }
        skip = that.skip();
        return skip !== undefined ? math.round((skip || 0) / (that.take() || 1)) + 1 : undefined;
      },
      pageSize: function(val) {
        var that = this;
        if (val !== undefined) {
          that._query({
            pageSize: val,
            page: 1
          });
          return ;
        }
        return that.take();
      },
      sort: function(val) {
        var that = this;
        if (val !== undefined) {
          that._query({sort: val});
          return ;
        }
        return that._sort;
      },
      filter: function(val) {
        var that = this;
        if (val === undefined) {
          return that._filter;
        }
        that.trigger("reset");
        that._query({
          filter: val,
          page: 1
        });
      },
      group: function(val) {
        var that = this;
        if (val !== undefined) {
          that._query({group: val});
          return ;
        }
        return that._group;
      },
      total: function() {
        return parseInt(this._total || 0, 10);
      },
      aggregate: function(val) {
        var that = this;
        if (val !== undefined) {
          that._query({aggregate: val});
          return ;
        }
        return that._aggregate;
      },
      aggregates: function() {
        var result = this._aggregateResult;
        if (isEmptyObject(result)) {
          result = this._emptyAggregates(this.aggregate());
        }
        return result;
      },
      _emptyAggregates: function(aggregates) {
        var result = {};
        if (!isEmptyObject(aggregates)) {
          var aggregate = {};
          if (!isArray(aggregates)) {
            aggregates = [aggregates];
          }
          for (var idx = 0; idx < aggregates.length; idx++) {
            aggregate[aggregates[idx].aggregate] = 0;
            result[aggregates[idx].field] = aggregate;
          }
        }
        return result;
      },
      _wrapInEmptyGroup: function(model) {
        var groups = this.group(),
            parent,
            group,
            idx,
            length;
        for (idx = groups.length - 1, length = 0; idx >= length; idx--) {
          group = groups[idx];
          parent = {
            value: model.get(group.field),
            field: group.field,
            items: parent ? [parent] : [model],
            hasSubgroups: !!parent,
            aggregates: this._emptyAggregates(group.aggregates)
          };
        }
        return parent;
      },
      totalPages: function() {
        var that = this,
            pageSize = that.pageSize() || that.total();
        return math.ceil((that.total() || 0) / pageSize);
      },
      inRange: function(skip, take) {
        var that = this,
            end = math.min(skip + take, that.total());
        if (!that.options.serverPaging && that._data.length > 0) {
          return true;
        }
        return that._findRange(skip, end).length > 0;
      },
      lastRange: function() {
        var ranges = this._ranges;
        return ranges[ranges.length - 1] || {
          start: 0,
          end: 0,
          data: []
        };
      },
      firstItemUid: function() {
        var ranges = this._ranges;
        return ranges.length && ranges[0].data.length && ranges[0].data[0].uid;
      },
      enableRequestsInProgress: function() {
        this._skipRequestsInProgress = false;
      },
      _timeStamp: function() {
        return new Date().getTime();
      },
      range: function(skip, take) {
        this._currentRequestTimeStamp = this._timeStamp();
        this._skipRequestsInProgress = true;
        skip = math.min(skip || 0, this.total());
        var that = this,
            pageSkip = math.max(math.floor(skip / take), 0) * take,
            size = math.min(pageSkip + take, that.total()),
            data;
        data = that._findRange(skip, math.min(skip + take, that.total()));
        if (data.length) {
          that._pending = undefined;
          that._skip = skip > that.skip() ? math.min(size, (that.totalPages() - 1) * that.take()) : pageSkip;
          that._take = take;
          var paging = that.options.serverPaging;
          var sorting = that.options.serverSorting;
          var filtering = that.options.serverFiltering;
          var aggregates = that.options.serverAggregates;
          try {
            that.options.serverPaging = true;
            if (!that._isServerGrouped() && !(that.group() && that.group().length)) {
              that.options.serverSorting = true;
            }
            that.options.serverFiltering = true;
            that.options.serverPaging = true;
            that.options.serverAggregates = true;
            if (paging) {
              that._detachObservableParents();
              that._data = data = that._observe(data);
            }
            that._process(data);
          } finally {
            that.options.serverPaging = paging;
            that.options.serverSorting = sorting;
            that.options.serverFiltering = filtering;
            that.options.serverAggregates = aggregates;
          }
          return ;
        }
        if (take !== undefined) {
          if (!that._rangeExists(pageSkip, size)) {
            that.prefetch(pageSkip, take, function() {
              if (skip > pageSkip && size < that.total() && !that._rangeExists(size, math.min(size + take, that.total()))) {
                that.prefetch(size, take, function() {
                  that.range(skip, take);
                });
              } else {
                that.range(skip, take);
              }
            });
          } else if (pageSkip < skip) {
            that.prefetch(size, take, function() {
              that.range(skip, take);
            });
          }
        }
      },
      _findRange: function(start, end) {
        var that = this,
            ranges = that._ranges,
            range,
            data = [],
            skipIdx,
            takeIdx,
            startIndex,
            endIndex,
            rangeData,
            rangeEnd,
            processed,
            options = that.options,
            remote = options.serverSorting || options.serverPaging || options.serverFiltering || options.serverGrouping || options.serverAggregates,
            flatData,
            count,
            length;
        for (skipIdx = 0, length = ranges.length; skipIdx < length; skipIdx++) {
          range = ranges[skipIdx];
          if (start >= range.start && start <= range.end) {
            count = 0;
            for (takeIdx = skipIdx; takeIdx < length; takeIdx++) {
              range = ranges[takeIdx];
              flatData = that._flatData(range.data, true);
              if (flatData.length && start + count >= range.start) {
                rangeData = range.data;
                rangeEnd = range.end;
                if (!remote) {
                  var sort = normalizeGroup(that.group() || []).concat(normalizeSort(that.sort() || []));
                  processed = that._queryProcess(range.data, {
                    sort: sort,
                    filter: that.filter()
                  });
                  flatData = rangeData = processed.data;
                  if (processed.total !== undefined) {
                    rangeEnd = processed.total;
                  }
                }
                startIndex = 0;
                if (start + count > range.start) {
                  startIndex = (start + count) - range.start;
                }
                endIndex = flatData.length;
                if (rangeEnd > end) {
                  endIndex = endIndex - (rangeEnd - end);
                }
                count += endIndex - startIndex;
                data = that._mergeGroups(data, rangeData, startIndex, endIndex);
                if (end <= range.end && count == end - start) {
                  return data;
                }
              }
            }
            break;
          }
        }
        return [];
      },
      _mergeGroups: function(data, range, skip, take) {
        if (this._isServerGrouped()) {
          var temp = range.toJSON(),
              prevGroup;
          if (data.length) {
            prevGroup = data[data.length - 1];
          }
          mergeGroups(prevGroup, temp, skip, take);
          return data.concat(temp);
        }
        return data.concat(range.slice(skip, take));
      },
      skip: function() {
        var that = this;
        if (that._skip === undefined) {
          return (that._page !== undefined ? (that._page - 1) * (that.take() || 1) : undefined);
        }
        return that._skip;
      },
      take: function() {
        return this._take || this._pageSize;
      },
      _prefetchSuccessHandler: function(skip, size, callback, force) {
        var that = this;
        var timestamp = that._timeStamp();
        return function(data) {
          var found = false,
              range = {
                start: skip,
                end: size,
                data: [],
                timestamp: that._timeStamp()
              },
              idx,
              length,
              temp;
          that._dequeueRequest();
          that.trigger(REQUESTEND, {
            response: data,
            type: "read"
          });
          data = that.reader.parse(data);
          temp = that._readData(data);
          if (temp.length) {
            for (idx = 0, length = that._ranges.length; idx < length; idx++) {
              if (that._ranges[idx].start === skip) {
                found = true;
                range = that._ranges[idx];
                break;
              }
            }
            if (!found) {
              that._ranges.push(range);
            }
          }
          range.data = that._observe(temp);
          range.end = range.start + that._flatData(range.data, true).length;
          that._ranges.sort(function(x, y) {
            return x.start - y.start;
          });
          that._total = that.reader.total(data);
          if (force || (timestamp >= that._currentRequestTimeStamp || !that._skipRequestsInProgress)) {
            if (callback && temp.length) {
              callback();
            } else {
              that.trigger(CHANGE, {});
            }
          }
        };
      },
      prefetch: function(skip, take, callback) {
        var that = this,
            size = math.min(skip + take, that.total()),
            options = {
              take: take,
              skip: skip,
              page: skip / take + 1,
              pageSize: take,
              sort: that._sort,
              filter: that._filter,
              group: that._group,
              aggregate: that._aggregate
            };
        if (!that._rangeExists(skip, size)) {
          clearTimeout(that._timeout);
          that._timeout = setTimeout(function() {
            that._queueRequest(options, function() {
              if (!that.trigger(REQUESTSTART, {type: "read"})) {
                that.transport.read({
                  data: that._params(options),
                  success: that._prefetchSuccessHandler(skip, size, callback),
                  error: function() {
                    var args = slice.call(arguments);
                    that.error.apply(that, args);
                  }
                });
              } else {
                that._dequeueRequest();
              }
            });
          }, 100);
        } else if (callback) {
          callback();
        }
      },
      _multiplePrefetch: function(skip, take, callback) {
        var that = this,
            size = math.min(skip + take, that.total()),
            options = {
              take: take,
              skip: skip,
              page: skip / take + 1,
              pageSize: take,
              sort: that._sort,
              filter: that._filter,
              group: that._group,
              aggregate: that._aggregate
            };
        if (!that._rangeExists(skip, size)) {
          if (!that.trigger(REQUESTSTART, {type: "read"})) {
            that.transport.read({
              data: that._params(options),
              success: that._prefetchSuccessHandler(skip, size, callback, true)
            });
          }
        } else if (callback) {
          callback();
        }
      },
      _rangeExists: function(start, end) {
        var that = this,
            ranges = that._ranges,
            idx,
            length;
        for (idx = 0, length = ranges.length; idx < length; idx++) {
          if (ranges[idx].start <= start && ranges[idx].end >= end) {
            return true;
          }
        }
        return false;
      },
      _removeModelFromRanges: function(model) {
        var result,
            found,
            range;
        for (var idx = 0,
            length = this._ranges.length; idx < length; idx++) {
          range = this._ranges[idx];
          this._eachItem(range.data, function(items) {
            result = removeModel(items, model);
            if (result) {
              found = true;
            }
          });
          if (found) {
            break;
          }
        }
      },
      _updateRangesLength: function() {
        var startOffset = 0,
            range,
            rangeLength;
        for (var idx = 0,
            length = this._ranges.length; idx < length; idx++) {
          range = this._ranges[idx];
          range.start = range.start - startOffset;
          rangeLength = this._flatData(range.data, true).length;
          startOffset = range.end - rangeLength;
          range.end = range.start + rangeLength;
        }
      }
    });
    var Transport = {};
    Transport.create = function(options, data, dataSource) {
      var transport,
          transportOptions = options.transport;
      if (transportOptions) {
        transportOptions.read = typeof transportOptions.read === STRING ? {url: transportOptions.read} : transportOptions.read;
        if (dataSource) {
          transportOptions.dataSource = dataSource;
        }
        if (options.type) {
          kendo.data.transports = kendo.data.transports || {};
          kendo.data.schemas = kendo.data.schemas || {};
          if (kendo.data.transports[options.type] && !isPlainObject(kendo.data.transports[options.type])) {
            transport = new kendo.data.transports[options.type](extend(transportOptions, {data: data}));
          } else {
            transportOptions = extend(true, {}, kendo.data.transports[options.type], transportOptions);
          }
          options.schema = extend(true, {}, kendo.data.schemas[options.type], options.schema);
        }
        if (!transport) {
          transport = isFunction(transportOptions.read) ? transportOptions : new RemoteTransport(transportOptions);
        }
      } else {
        transport = new LocalTransport({data: options.data || []});
      }
      return transport;
    };
    DataSource.create = function(options) {
      if (isArray(options) || options instanceof ObservableArray) {
        options = {data: options};
      }
      var dataSource = options || {},
          data = dataSource.data,
          fields = dataSource.fields,
          table = dataSource.table,
          select = dataSource.select,
          idx,
          length,
          model = {},
          field;
      if (!data && fields && !dataSource.transport) {
        if (table) {
          data = inferTable(table, fields);
        } else if (select) {
          data = inferSelect(select, fields);
          if (dataSource.group === undefined && data[0] && data[0].optgroup !== undefined) {
            dataSource.group = "optgroup";
          }
        }
      }
      if (kendo.data.Model && fields && (!dataSource.schema || !dataSource.schema.model)) {
        for (idx = 0, length = fields.length; idx < length; idx++) {
          field = fields[idx];
          if (field.type) {
            model[field.field] = field;
          }
        }
        if (!isEmptyObject(model)) {
          dataSource.schema = extend(true, dataSource.schema, {model: {fields: model}});
        }
      }
      dataSource.data = data;
      select = null;
      dataSource.select = null;
      table = null;
      dataSource.table = null;
      return dataSource instanceof DataSource ? dataSource : new DataSource(dataSource);
    };
    function inferSelect(select, fields) {
      select = $(select)[0];
      var options = select.options;
      var firstField = fields[0];
      var secondField = fields[1];
      var data = [];
      var idx,
          length;
      var optgroup;
      var option;
      var record;
      var value;
      for (idx = 0, length = options.length; idx < length; idx++) {
        record = {};
        option = options[idx];
        optgroup = option.parentNode;
        if (optgroup === select) {
          optgroup = null;
        }
        if (option.disabled || (optgroup && optgroup.disabled)) {
          continue;
        }
        if (optgroup) {
          record.optgroup = optgroup.label;
        }
        record[firstField.field] = option.text;
        value = option.attributes.value;
        if (value && value.specified) {
          value = option.value;
        } else {
          value = option.text;
        }
        record[secondField.field] = value;
        data.push(record);
      }
      return data;
    }
    function inferTable(table, fields) {
      var tbody = $(table)[0].tBodies[0],
          rows = tbody ? tbody.rows : [],
          idx,
          length,
          fieldIndex,
          fieldCount = fields.length,
          data = [],
          cells,
          record,
          cell,
          empty;
      for (idx = 0, length = rows.length; idx < length; idx++) {
        record = {};
        empty = true;
        cells = rows[idx].cells;
        for (fieldIndex = 0; fieldIndex < fieldCount; fieldIndex++) {
          cell = cells[fieldIndex];
          if (cell.nodeName.toLowerCase() !== "th") {
            empty = false;
            record[fields[fieldIndex].field] = cell.innerHTML;
          }
        }
        if (!empty) {
          data.push(record);
        }
      }
      return data;
    }
    var Node = Model.define({
      idField: "id",
      init: function(value) {
        var that = this,
            hasChildren = that.hasChildren || value && value.hasChildren,
            childrenField = "items",
            childrenOptions = {};
        kendo.data.Model.fn.init.call(that, value);
        if (typeof that.children === STRING) {
          childrenField = that.children;
        }
        childrenOptions = {schema: {
            data: childrenField,
            model: {
              hasChildren: hasChildren,
              id: that.idField,
              fields: that.fields
            }
          }};
        if (typeof that.children !== STRING) {
          extend(childrenOptions, that.children);
        }
        childrenOptions.data = value;
        if (!hasChildren) {
          hasChildren = childrenOptions.schema.data;
        }
        if (typeof hasChildren === STRING) {
          hasChildren = kendo.getter(hasChildren);
        }
        if (isFunction(hasChildren)) {
          that.hasChildren = !!hasChildren.call(that, that);
        }
        that._childrenOptions = childrenOptions;
        if (that.hasChildren) {
          that._initChildren();
        }
        that._loaded = !!(value && (value[childrenField] || value._loaded));
      },
      _initChildren: function() {
        var that = this;
        var children,
            transport,
            parameterMap;
        if (!(that.children instanceof HierarchicalDataSource)) {
          children = that.children = new HierarchicalDataSource(that._childrenOptions);
          transport = children.transport;
          parameterMap = transport.parameterMap;
          transport.parameterMap = function(data, type) {
            data[that.idField || "id"] = that.id;
            if (parameterMap) {
              data = parameterMap(data, type);
            }
            return data;
          };
          children.parent = function() {
            return that;
          };
          children.bind(CHANGE, function(e) {
            e.node = e.node || that;
            that.trigger(CHANGE, e);
          });
          children.bind(ERROR, function(e) {
            var collection = that.parent();
            if (collection) {
              e.node = e.node || that;
              collection.trigger(ERROR, e);
            }
          });
          that._updateChildrenField();
        }
      },
      append: function(model) {
        this._initChildren();
        this.loaded(true);
        this.children.add(model);
      },
      hasChildren: false,
      level: function() {
        var parentNode = this.parentNode(),
            level = 0;
        while (parentNode && parentNode.parentNode) {
          level++;
          parentNode = parentNode.parentNode ? parentNode.parentNode() : null;
        }
        return level;
      },
      _updateChildrenField: function() {
        var fieldName = this._childrenOptions.schema.data;
        this[fieldName || "items"] = this.children.data();
      },
      _childrenLoaded: function() {
        this._loaded = true;
        this._updateChildrenField();
      },
      load: function() {
        var options = {};
        var method = "_query";
        var children,
            promise;
        if (this.hasChildren) {
          this._initChildren();
          children = this.children;
          options[this.idField || "id"] = this.id;
          if (!this._loaded) {
            children._data = undefined;
            method = "read";
          }
          children.one(CHANGE, proxy(this._childrenLoaded, this));
          promise = children[method](options);
        } else {
          this.loaded(true);
        }
        return promise || $.Deferred().resolve().promise();
      },
      parentNode: function() {
        var array = this.parent();
        return array.parent();
      },
      loaded: function(value) {
        if (value !== undefined) {
          this._loaded = value;
        } else {
          return this._loaded;
        }
      },
      shouldSerialize: function(field) {
        return Model.fn.shouldSerialize.call(this, field) && field !== "children" && field !== "_loaded" && field !== "hasChildren" && field !== "_childrenOptions";
      }
    });
    function dataMethod(name) {
      return function() {
        var data = this._data,
            result = DataSource.fn[name].apply(this, slice.call(arguments));
        if (this._data != data) {
          this._attachBubbleHandlers();
        }
        return result;
      };
    }
    var HierarchicalDataSource = DataSource.extend({
      init: function(options) {
        var node = Node.define({children: options});
        DataSource.fn.init.call(this, extend(true, {}, {schema: {
            modelBase: node,
            model: node
          }}, options));
        this._attachBubbleHandlers();
      },
      _attachBubbleHandlers: function() {
        var that = this;
        that._data.bind(ERROR, function(e) {
          that.trigger(ERROR, e);
        });
      },
      remove: function(node) {
        var parentNode = node.parentNode(),
            dataSource = this,
            result;
        if (parentNode && parentNode._initChildren) {
          dataSource = parentNode.children;
        }
        result = DataSource.fn.remove.call(dataSource, node);
        if (parentNode && !dataSource.data().length) {
          parentNode.hasChildren = false;
        }
        return result;
      },
      success: dataMethod("success"),
      data: dataMethod("data"),
      insert: function(index, model) {
        var parentNode = this.parent();
        if (parentNode && parentNode._initChildren) {
          parentNode.hasChildren = true;
          parentNode._initChildren();
        }
        return DataSource.fn.insert.call(this, index, model);
      },
      _find: function(method, value) {
        var idx,
            length,
            node,
            data,
            children;
        node = DataSource.fn[method].call(this, value);
        if (node) {
          return node;
        }
        data = this._flatData(this._data);
        if (!data) {
          return ;
        }
        for (idx = 0, length = data.length; idx < length; idx++) {
          children = data[idx].children;
          if (!(children instanceof HierarchicalDataSource)) {
            continue;
          }
          node = children[method](value);
          if (node) {
            return node;
          }
        }
      },
      get: function(id) {
        return this._find("get", id);
      },
      getByUid: function(uid) {
        return this._find("getByUid", uid);
      }
    });
    function inferList(list, fields) {
      var items = $(list).children(),
          idx,
          length,
          data = [],
          record,
          textField = fields[0].field,
          urlField = fields[1] && fields[1].field,
          spriteCssClassField = fields[2] && fields[2].field,
          imageUrlField = fields[3] && fields[3].field,
          item,
          id,
          textChild,
          className,
          children;
      function elements(collection, tagName) {
        return collection.filter(tagName).add(collection.find(tagName));
      }
      for (idx = 0, length = items.length; idx < length; idx++) {
        record = {_loaded: true};
        item = items.eq(idx);
        textChild = item[0].firstChild;
        children = item.children();
        list = children.filter("ul");
        children = children.filter(":not(ul)");
        id = item.attr("data-id");
        if (id) {
          record.id = id;
        }
        if (textChild) {
          record[textField] = textChild.nodeType == 3 ? textChild.nodeValue : children.text();
        }
        if (urlField) {
          record[urlField] = elements(children, "a").attr("href");
        }
        if (imageUrlField) {
          record[imageUrlField] = elements(children, "img").attr("src");
        }
        if (spriteCssClassField) {
          className = elements(children, ".k-sprite").prop("className");
          record[spriteCssClassField] = className && $.trim(className.replace("k-sprite", ""));
        }
        if (list.length) {
          record.items = inferList(list.eq(0), fields);
        }
        if (item.attr("data-hasChildren") == "true") {
          record.hasChildren = true;
        }
        data.push(record);
      }
      return data;
    }
    HierarchicalDataSource.create = function(options) {
      options = options && options.push ? {data: options} : options;
      var dataSource = options || {},
          data = dataSource.data,
          fields = dataSource.fields,
          list = dataSource.list;
      if (data && data._dataSource) {
        return data._dataSource;
      }
      if (!data && fields && !dataSource.transport) {
        if (list) {
          data = inferList(list, fields);
        }
      }
      dataSource.data = data;
      return dataSource instanceof HierarchicalDataSource ? dataSource : new HierarchicalDataSource(dataSource);
    };
    var Buffer = kendo.Observable.extend({
      init: function(dataSource, viewSize, disablePrefetch) {
        kendo.Observable.fn.init.call(this);
        this._prefetching = false;
        this.dataSource = dataSource;
        this.prefetch = !disablePrefetch;
        var buffer = this;
        dataSource.bind("change", function() {
          buffer._change();
        });
        dataSource.bind("reset", function() {
          buffer._reset();
        });
        this._syncWithDataSource();
        this.setViewSize(viewSize);
      },
      setViewSize: function(viewSize) {
        this.viewSize = viewSize;
        this._recalculate();
      },
      at: function(index) {
        var pageSize = this.pageSize,
            item,
            itemPresent = true,
            changeTo;
        if (index >= this.total()) {
          this.trigger("endreached", {index: index});
          return null;
        }
        if (!this.useRanges) {
          return this.dataSource.view()[index];
        }
        if (this.useRanges) {
          if (index < this.dataOffset || index >= this.skip + pageSize) {
            itemPresent = this.range(Math.floor(index / pageSize) * pageSize);
          }
          if (index === this.prefetchThreshold) {
            this._prefetch();
          }
          if (index === this.midPageThreshold) {
            this.range(this.nextMidRange, true);
          } else if (index === this.nextPageThreshold) {
            this.range(this.nextFullRange);
          } else if (index === this.pullBackThreshold) {
            if (this.offset === this.skip) {
              this.range(this.previousMidRange);
            } else {
              this.range(this.previousFullRange);
            }
          }
          if (itemPresent) {
            return this.dataSource.at(index - this.dataOffset);
          } else {
            this.trigger("endreached", {index: index});
            return null;
          }
        }
      },
      indexOf: function(item) {
        return this.dataSource.data().indexOf(item) + this.dataOffset;
      },
      total: function() {
        return parseInt(this.dataSource.total(), 10);
      },
      next: function() {
        var buffer = this,
            pageSize = buffer.pageSize,
            offset = buffer.skip - buffer.viewSize + pageSize,
            pageSkip = math.max(math.floor(offset / pageSize), 0) * pageSize;
        this.offset = offset;
        this.dataSource.prefetch(pageSkip, pageSize, function() {
          buffer._goToRange(offset, true);
        });
      },
      range: function(offset, nextRange) {
        if (this.offset === offset) {
          return true;
        }
        var buffer = this,
            pageSize = this.pageSize,
            pageSkip = math.max(math.floor(offset / pageSize), 0) * pageSize,
            dataSource = this.dataSource;
        if (nextRange) {
          pageSkip += pageSize;
        }
        if (dataSource.inRange(offset, pageSize)) {
          this.offset = offset;
          this._recalculate();
          this._goToRange(offset);
          return true;
        } else if (this.prefetch) {
          dataSource.prefetch(pageSkip, pageSize, function() {
            buffer.offset = offset;
            buffer._recalculate();
            buffer._goToRange(offset, true);
          });
          return false;
        }
        return true;
      },
      syncDataSource: function() {
        var offset = this.offset;
        this.offset = null;
        this.range(offset);
      },
      destroy: function() {
        this.unbind();
      },
      _prefetch: function() {
        var buffer = this,
            pageSize = this.pageSize,
            prefetchOffset = this.skip + pageSize,
            dataSource = this.dataSource;
        if (!dataSource.inRange(prefetchOffset, pageSize) && !this._prefetching && this.prefetch) {
          this._prefetching = true;
          this.trigger("prefetching", {
            skip: prefetchOffset,
            take: pageSize
          });
          dataSource.prefetch(prefetchOffset, pageSize, function() {
            buffer._prefetching = false;
            buffer.trigger("prefetched", {
              skip: prefetchOffset,
              take: pageSize
            });
          });
        }
      },
      _goToRange: function(offset, expanding) {
        if (this.offset !== offset) {
          return ;
        }
        this.dataOffset = offset;
        this._expanding = expanding;
        this.dataSource.range(offset, this.pageSize);
        this.dataSource.enableRequestsInProgress();
      },
      _reset: function() {
        this._syncPending = true;
      },
      _change: function() {
        var dataSource = this.dataSource;
        this.length = this.useRanges ? dataSource.lastRange().end : dataSource.view().length;
        if (this._syncPending) {
          this._syncWithDataSource();
          this._recalculate();
          this._syncPending = false;
          this.trigger("reset", {offset: this.offset});
        }
        this.trigger("resize");
        if (this._expanding) {
          this.trigger("expand");
        }
        delete this._expanding;
      },
      _syncWithDataSource: function() {
        var dataSource = this.dataSource;
        this._firstItemUid = dataSource.firstItemUid();
        this.dataOffset = this.offset = dataSource.skip() || 0;
        this.pageSize = dataSource.pageSize();
        this.useRanges = dataSource.options.serverPaging;
      },
      _recalculate: function() {
        var pageSize = this.pageSize,
            offset = this.offset,
            viewSize = this.viewSize,
            skip = Math.ceil(offset / pageSize) * pageSize;
        this.skip = skip;
        this.midPageThreshold = skip + pageSize - 1;
        this.nextPageThreshold = skip + viewSize - 1;
        this.prefetchThreshold = skip + Math.floor(pageSize / 3 * 2);
        this.pullBackThreshold = this.offset - 1;
        this.nextMidRange = skip + pageSize - viewSize;
        this.nextFullRange = skip;
        this.previousMidRange = offset - viewSize;
        this.previousFullRange = skip - pageSize;
      }
    });
    var BatchBuffer = kendo.Observable.extend({
      init: function(dataSource, batchSize) {
        var batchBuffer = this;
        kendo.Observable.fn.init.call(batchBuffer);
        this.dataSource = dataSource;
        this.batchSize = batchSize;
        this._total = 0;
        this.buffer = new Buffer(dataSource, batchSize * 3);
        this.buffer.bind({
          "endreached": function(e) {
            batchBuffer.trigger("endreached", {index: e.index});
          },
          "prefetching": function(e) {
            batchBuffer.trigger("prefetching", {
              skip: e.skip,
              take: e.take
            });
          },
          "prefetched": function(e) {
            batchBuffer.trigger("prefetched", {
              skip: e.skip,
              take: e.take
            });
          },
          "reset": function() {
            batchBuffer._total = 0;
            batchBuffer.trigger("reset");
          },
          "resize": function() {
            batchBuffer._total = Math.ceil(this.length / batchBuffer.batchSize);
            batchBuffer.trigger("resize", {
              total: batchBuffer.total(),
              offset: this.offset
            });
          }
        });
      },
      syncDataSource: function() {
        this.buffer.syncDataSource();
      },
      at: function(index) {
        var buffer = this.buffer,
            skip = index * this.batchSize,
            take = this.batchSize,
            view = [],
            item;
        if (buffer.offset > skip) {
          buffer.at(buffer.offset - 1);
        }
        for (var i = 0; i < take; i++) {
          item = buffer.at(skip + i);
          if (item === null) {
            break;
          }
          view.push(item);
        }
        return view;
      },
      total: function() {
        return this._total;
      },
      destroy: function() {
        this.buffer.destroy();
        this.unbind();
      }
    });
    extend(true, kendo.data, {
      readers: {json: DataReader},
      Query: Query,
      DataSource: DataSource,
      HierarchicalDataSource: HierarchicalDataSource,
      Node: Node,
      ObservableObject: ObservableObject,
      ObservableArray: ObservableArray,
      LazyObservableArray: LazyObservableArray,
      LocalTransport: LocalTransport,
      RemoteTransport: RemoteTransport,
      Cache: Cache,
      DataReader: DataReader,
      Model: Model,
      Buffer: Buffer,
      BatchBuffer: BatchBuffer
    });
  })(window.kendo.jQuery);
  return window.kendo;
}, typeof define == 'function' && define.amd ? define : function(_, f) {
  f();
});
})();
(function() {
function define(){};  define.amd = {};
(function(f, define) {
  define(["./kendo.core", "./kendo.data"], f);
})(function() {
  (function($, undefined) {
    var kendo = window.kendo,
        browser = kendo.support.browser,
        Observable = kendo.Observable,
        ObservableObject = kendo.data.ObservableObject,
        ObservableArray = kendo.data.ObservableArray,
        toString = {}.toString,
        binders = {},
        slice = Array.prototype.slice,
        Class = kendo.Class,
        proxy = $.proxy,
        VALUE = "value",
        SOURCE = "source",
        EVENTS = "events",
        CHECKED = "checked",
        CSS = "css",
        deleteExpando = true,
        CHANGE = "change";
    (function() {
      var a = document.createElement("a");
      try {
        delete a.test;
      } catch (e) {
        deleteExpando = false;
      }
    })();
    var Binding = Observable.extend({
      init: function(parents, path) {
        var that = this;
        Observable.fn.init.call(that);
        that.source = parents[0];
        that.parents = parents;
        that.path = path;
        that.dependencies = {};
        that.dependencies[path] = true;
        that.observable = that.source instanceof Observable;
        that._access = function(e) {
          that.dependencies[e.field] = true;
        };
        if (that.observable) {
          that._change = function(e) {
            that.change(e);
          };
          that.source.bind(CHANGE, that._change);
        }
      },
      _parents: function() {
        var parents = this.parents;
        var value = this.get();
        if (value && typeof value.parent == "function") {
          var parent = value.parent();
          if ($.inArray(parent, parents) < 0) {
            parents = [parent].concat(parents);
          }
        }
        return parents;
      },
      change: function(e) {
        var dependency,
            ch,
            field = e.field,
            that = this;
        if (that.path === "this") {
          that.trigger(CHANGE, e);
        } else {
          for (dependency in that.dependencies) {
            if (dependency.indexOf(field) === 0) {
              ch = dependency.charAt(field.length);
              if (!ch || ch === "." || ch === "[") {
                that.trigger(CHANGE, e);
                break;
              }
            }
          }
        }
      },
      start: function(source) {
        source.bind("get", this._access);
      },
      stop: function(source) {
        source.unbind("get", this._access);
      },
      get: function() {
        var that = this,
            source = that.source,
            index = 0,
            path = that.path,
            result = source;
        if (!that.observable) {
          return result;
        }
        that.start(that.source);
        result = source.get(path);
        while (result === undefined && source) {
          source = that.parents[++index];
          if (source instanceof ObservableObject) {
            result = source.get(path);
          }
        }
        if (result === undefined) {
          source = that.source;
          while (result === undefined && source) {
            source = source.parent();
            if (source instanceof ObservableObject) {
              result = source.get(path);
            }
          }
        }
        if (typeof result === "function") {
          index = path.lastIndexOf(".");
          if (index > 0) {
            source = source.get(path.substring(0, index));
          }
          that.start(source);
          if (source !== that.source) {
            result = result.call(source, that.source);
          } else {
            result = result.call(source);
          }
          that.stop(source);
        }
        if (source && source !== that.source) {
          that.currentSource = source;
          source.unbind(CHANGE, that._change).bind(CHANGE, that._change);
        }
        that.stop(that.source);
        return result;
      },
      set: function(value) {
        var source = this.currentSource || this.source;
        var field = kendo.getter(this.path)(source);
        if (typeof field === "function") {
          if (source !== this.source) {
            field.call(source, this.source, value);
          } else {
            field.call(source, value);
          }
        } else {
          source.set(this.path, value);
        }
      },
      destroy: function() {
        if (this.observable) {
          this.source.unbind(CHANGE, this._change);
          if (this.currentSource) {
            this.currentSource.unbind(CHANGE, this._change);
          }
        }
        this.unbind();
      }
    });
    var EventBinding = Binding.extend({get: function() {
        var source = this.source,
            path = this.path,
            index = 0,
            handler;
        handler = source.get(path);
        while (!handler && source) {
          source = this.parents[++index];
          if (source instanceof ObservableObject) {
            handler = source.get(path);
          }
        }
        return proxy(handler, source);
      }});
    var TemplateBinding = Binding.extend({
      init: function(source, path, template) {
        var that = this;
        Binding.fn.init.call(that, source, path);
        that.template = template;
      },
      render: function(value) {
        var html;
        this.start(this.source);
        html = kendo.render(this.template, value);
        this.stop(this.source);
        return html;
      }
    });
    var Binder = Class.extend({
      init: function(element, bindings, options) {
        this.element = element;
        this.bindings = bindings;
        this.options = options;
      },
      bind: function(binding, attribute) {
        var that = this;
        binding = attribute ? binding[attribute] : binding;
        binding.bind(CHANGE, function(e) {
          that.refresh(attribute || e);
        });
        that.refresh(attribute);
      },
      destroy: function() {}
    });
    var TypedBinder = Binder.extend({
      dataType: function() {
        var dataType = this.element.getAttribute("data-type") || this.element.type || "text";
        return dataType.toLowerCase();
      },
      parsedValue: function() {
        return this._parseValue(this.element.value, this.dataType());
      },
      _parseValue: function(value, dataType) {
        if (dataType == "date") {
          value = kendo.parseDate(value, "yyyy-MM-dd");
        } else if (dataType == "datetime-local") {
          value = kendo.parseDate(value, ["yyyy-MM-ddTHH:mm:ss", "yyyy-MM-ddTHH:mm"]);
        } else if (dataType == "number") {
          value = kendo.parseFloat(value);
        } else if (dataType == "boolean") {
          value = value.toLowerCase();
          if (kendo.parseFloat(value) !== null) {
            value = Boolean(kendo.parseFloat(value));
          } else {
            value = (value.toLowerCase() === "true");
          }
        }
        return value;
      }
    });
    binders.attr = Binder.extend({refresh: function(key) {
        this.element.setAttribute(key, this.bindings.attr[key].get());
      }});
    binders.css = Binder.extend({
      init: function(element, bindings, options) {
        Binder.fn.init.call(this, element, bindings, options);
        this.classes = {};
      },
      refresh: function(className) {
        var element = $(this.element),
            binding = this.bindings.css[className],
            hasClass = this.classes[className] = binding.get();
        if (hasClass) {
          element.addClass(className);
        } else {
          element.removeClass(className);
        }
      }
    });
    binders.style = Binder.extend({refresh: function(key) {
        this.element.style[key] = this.bindings.style[key].get() || "";
      }});
    binders.enabled = Binder.extend({refresh: function() {
        if (this.bindings.enabled.get()) {
          this.element.removeAttribute("disabled");
        } else {
          this.element.setAttribute("disabled", "disabled");
        }
      }});
    binders.readonly = Binder.extend({refresh: function() {
        if (this.bindings.readonly.get()) {
          this.element.setAttribute("readonly", "readonly");
        } else {
          this.element.removeAttribute("readonly");
        }
      }});
    binders.disabled = Binder.extend({refresh: function() {
        if (this.bindings.disabled.get()) {
          this.element.setAttribute("disabled", "disabled");
        } else {
          this.element.removeAttribute("disabled");
        }
      }});
    binders.events = Binder.extend({
      init: function(element, bindings, options) {
        Binder.fn.init.call(this, element, bindings, options);
        this.handlers = {};
      },
      refresh: function(key) {
        var element = $(this.element),
            binding = this.bindings.events[key],
            handler = this.handlers[key];
        if (handler) {
          element.off(key, handler);
        }
        handler = this.handlers[key] = binding.get();
        element.on(key, binding.source, handler);
      },
      destroy: function() {
        var element = $(this.element),
            handler;
        for (handler in this.handlers) {
          element.off(handler, this.handlers[handler]);
        }
      }
    });
    binders.text = Binder.extend({refresh: function() {
        var text = this.bindings.text.get();
        var dataFormat = this.element.getAttribute("data-format") || "";
        if (text == null) {
          text = "";
        }
        $(this.element).text(kendo.toString(text, dataFormat));
      }});
    binders.visible = Binder.extend({refresh: function() {
        if (this.bindings.visible.get()) {
          this.element.style.display = "";
        } else {
          this.element.style.display = "none";
        }
      }});
    binders.invisible = Binder.extend({refresh: function() {
        if (!this.bindings.invisible.get()) {
          this.element.style.display = "";
        } else {
          this.element.style.display = "none";
        }
      }});
    binders.html = Binder.extend({refresh: function() {
        this.element.innerHTML = this.bindings.html.get();
      }});
    binders.value = TypedBinder.extend({
      init: function(element, bindings, options) {
        TypedBinder.fn.init.call(this, element, bindings, options);
        this._change = proxy(this.change, this);
        this.eventName = options.valueUpdate || CHANGE;
        $(this.element).on(this.eventName, this._change);
        this._initChange = false;
      },
      change: function() {
        this._initChange = this.eventName != CHANGE;
        this.bindings[VALUE].set(this.parsedValue());
        this._initChange = false;
      },
      refresh: function() {
        if (!this._initChange) {
          var value = this.bindings[VALUE].get();
          if (value == null) {
            value = "";
          }
          var type = this.dataType();
          if (type == "date") {
            value = kendo.toString(value, "yyyy-MM-dd");
          } else if (type == "datetime-local") {
            value = kendo.toString(value, "yyyy-MM-ddTHH:mm:ss");
          }
          this.element.value = value;
        }
        this._initChange = false;
      },
      destroy: function() {
        $(this.element).off(this.eventName, this._change);
      }
    });
    binders.source = Binder.extend({
      init: function(element, bindings, options) {
        Binder.fn.init.call(this, element, bindings, options);
        var source = this.bindings.source.get();
        if (source instanceof kendo.data.DataSource && options.autoBind !== false) {
          source.fetch();
        }
      },
      refresh: function(e) {
        var that = this,
            source = that.bindings.source.get();
        if (source instanceof ObservableArray || source instanceof kendo.data.DataSource) {
          e = e || {};
          if (e.action == "add") {
            that.add(e.index, e.items);
          } else if (e.action == "remove") {
            that.remove(e.index, e.items);
          } else if (e.action != "itemchange") {
            that.render();
          }
        } else {
          that.render();
        }
      },
      container: function() {
        var element = this.element;
        if (element.nodeName.toLowerCase() == "table") {
          if (!element.tBodies[0]) {
            element.appendChild(document.createElement("tbody"));
          }
          element = element.tBodies[0];
        }
        return element;
      },
      template: function() {
        var options = this.options,
            template = options.template,
            nodeName = this.container().nodeName.toLowerCase();
        if (!template) {
          if (nodeName == "select") {
            if (options.valueField || options.textField) {
              template = kendo.format('<option value="#:{0}#">#:{1}#</option>', options.valueField || options.textField, options.textField || options.valueField);
            } else {
              template = "<option>#:data#</option>";
            }
          } else if (nodeName == "tbody") {
            template = "<tr><td>#:data#</td></tr>";
          } else if (nodeName == "ul" || nodeName == "ol") {
            template = "<li>#:data#</li>";
          } else {
            template = "#:data#";
          }
          template = kendo.template(template);
        }
        return template;
      },
      add: function(index, items) {
        var element = this.container(),
            parents,
            idx,
            length,
            child,
            clone = element.cloneNode(false),
            reference = element.children[index];
        $(clone).html(kendo.render(this.template(), items));
        if (clone.children.length) {
          parents = this.bindings.source._parents();
          for (idx = 0, length = items.length; idx < length; idx++) {
            child = clone.children[0];
            element.insertBefore(child, reference || null);
            bindElement(child, items[idx], this.options.roles, [items[idx]].concat(parents));
          }
        }
      },
      remove: function(index, items) {
        var idx,
            element = this.container();
        for (idx = 0; idx < items.length; idx++) {
          var child = element.children[index];
          unbindElementTree(child);
          element.removeChild(child);
        }
      },
      render: function() {
        var source = this.bindings.source.get(),
            parents,
            idx,
            length,
            element = this.container(),
            template = this.template();
        if (source instanceof kendo.data.DataSource) {
          source = source.view();
        }
        if (!(source instanceof ObservableArray) && toString.call(source) !== "[object Array]") {
          source = [source];
        }
        if (this.bindings.template) {
          unbindElementChildren(element);
          $(element).html(this.bindings.template.render(source));
          if (element.children.length) {
            parents = this.bindings.source._parents();
            for (idx = 0, length = source.length; idx < length; idx++) {
              bindElement(element.children[idx], source[idx], this.options.roles, [source[idx]].concat(parents));
            }
          }
        } else {
          $(element).html(kendo.render(template, source));
        }
      }
    });
    binders.input = {checked: TypedBinder.extend({
        init: function(element, bindings, options) {
          TypedBinder.fn.init.call(this, element, bindings, options);
          this._change = proxy(this.change, this);
          $(this.element).change(this._change);
        },
        change: function() {
          var element = this.element;
          var value = this.value();
          if (element.type == "radio") {
            value = this.parsedValue();
            this.bindings[CHECKED].set(value);
          } else if (element.type == "checkbox") {
            var source = this.bindings[CHECKED].get();
            var index;
            if (source instanceof ObservableArray) {
              value = this.parsedValue();
              if (value instanceof Date) {
                for (var i = 0; i < source.length; i++) {
                  if (source[i] instanceof Date && +source[i] === +value) {
                    index = i;
                    break;
                  }
                }
              } else {
                index = source.indexOf(value);
              }
              if (index > -1) {
                source.splice(index, 1);
              } else {
                source.push(value);
              }
            } else {
              this.bindings[CHECKED].set(value);
            }
          }
        },
        refresh: function() {
          var value = this.bindings[CHECKED].get(),
              source = value,
              type = this.dataType(),
              element = this.element;
          if (element.type == "checkbox") {
            if (source instanceof ObservableArray) {
              var index = -1;
              value = this.parsedValue();
              if (value instanceof Date) {
                for (var i = 0; i < source.length; i++) {
                  if (source[i] instanceof Date && +source[i] === +value) {
                    index = i;
                    break;
                  }
                }
              } else {
                index = source.indexOf(value);
              }
              element.checked = (index >= 0);
            } else {
              element.checked = source;
            }
          } else if (element.type == "radio" && value != null) {
            if (type == "date") {
              value = kendo.toString(value, "yyyy-MM-dd");
            } else if (type == "datetime-local") {
              value = kendo.toString(value, "yyyy-MM-ddTHH:mm:ss");
            }
            if (element.value === value.toString()) {
              element.checked = true;
            }
          }
        },
        value: function() {
          var element = this.element,
              value = element.value;
          if (element.type == "checkbox") {
            value = element.checked;
          }
          return value;
        },
        destroy: function() {
          $(this.element).off(CHANGE, this._change);
        }
      })};
    binders.select = {
      source: binders.source.extend({refresh: function(e) {
          var that = this,
              source = that.bindings.source.get();
          if (source instanceof ObservableArray || source instanceof kendo.data.DataSource) {
            e = e || {};
            if (e.action == "add") {
              that.add(e.index, e.items);
            } else if (e.action == "remove") {
              that.remove(e.index, e.items);
            } else if (e.action == "itemchange" || e.action === undefined) {
              that.render();
              if (that.bindings.value) {
                if (that.bindings.value) {
                  that.element.value = retrievePrimitiveValues(that.bindings.value.get(), $(that.element).data("valueField"));
                }
              }
            }
          } else {
            that.render();
          }
        }}),
      value: TypedBinder.extend({
        init: function(target, bindings, options) {
          TypedBinder.fn.init.call(this, target, bindings, options);
          this._change = proxy(this.change, this);
          $(this.element).change(this._change);
        },
        parsedValue: function() {
          var dataType = this.dataType();
          var values = [];
          var value,
              option,
              idx,
              length;
          for (idx = 0, length = this.element.options.length; idx < length; idx++) {
            option = this.element.options[idx];
            if (option.selected) {
              value = option.attributes.value;
              if (value && value.specified) {
                value = option.value;
              } else {
                value = option.text;
              }
              values.push(this._parseValue(value, dataType));
            }
          }
          return values;
        },
        change: function() {
          var values = [],
              element = this.element,
              source,
              field = this.options.valueField || this.options.textField,
              valuePrimitive = this.options.valuePrimitive,
              option,
              valueIndex,
              value,
              idx,
              length;
          values = this.parsedValue();
          if (field) {
            source = this.bindings.source.get();
            if (source instanceof kendo.data.DataSource) {
              source = source.view();
            }
            for (valueIndex = 0; valueIndex < values.length; valueIndex++) {
              for (idx = 0, length = source.length; idx < length; idx++) {
                var match = valuePrimitive ? (this._parseValue(values[valueIndex], this.dataType()) === source[idx].get(field)) : (this._parseValue(source[idx].get(field), this.dataType()).toString() === values[valueIndex]);
                if (match) {
                  values[valueIndex] = source[idx];
                  break;
                }
              }
            }
          }
          value = this.bindings[VALUE].get();
          if (value instanceof ObservableArray) {
            value.splice.apply(value, [0, value.length].concat(values));
          } else if (!valuePrimitive && (value instanceof ObservableObject || value === null || value === undefined || !field)) {
            this.bindings[VALUE].set(values[0]);
          } else {
            this.bindings[VALUE].set(values[0].get(field));
          }
        },
        refresh: function() {
          var optionIndex,
              element = this.element,
              options = element.options,
              valuePrimitive = this.options.valuePrimitive,
              value = this.bindings[VALUE].get(),
              values = value,
              field = this.options.valueField || this.options.textField,
              found = false,
              type = this.dataType(),
              optionValue;
          if (!(values instanceof ObservableArray)) {
            values = new ObservableArray([value]);
          }
          element.selectedIndex = -1;
          for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
            value = values[valueIndex];
            if (field && value instanceof ObservableObject) {
              value = value.get(field);
            }
            if (type == "date") {
              value = kendo.toString(values[valueIndex], "yyyy-MM-dd");
            } else if (type == "datetime-local") {
              value = kendo.toString(values[valueIndex], "yyyy-MM-ddTHH:mm:ss");
            }
            for (optionIndex = 0; optionIndex < options.length; optionIndex++) {
              optionValue = options[optionIndex].value;
              if (optionValue === "" && value !== "") {
                optionValue = options[optionIndex].text;
              }
              if (value != null && optionValue == value.toString()) {
                options[optionIndex].selected = true;
                found = true;
              }
            }
          }
        },
        destroy: function() {
          $(this.element).off(CHANGE, this._change);
        }
      })
    };
    function dataSourceBinding(bindingName, fieldName, setter) {
      return Binder.extend({
        init: function(widget, bindings, options) {
          var that = this;
          Binder.fn.init.call(that, widget.element[0], bindings, options);
          that.widget = widget;
          that._dataBinding = proxy(that.dataBinding, that);
          that._dataBound = proxy(that.dataBound, that);
          that._itemChange = proxy(that.itemChange, that);
        },
        itemChange: function(e) {
          bindElement(e.item[0], e.data, this._ns(e.ns), [e.data].concat(this.bindings[bindingName]._parents()));
        },
        dataBinding: function(e) {
          var idx,
              length,
              widget = this.widget,
              items = e.removedItems || widget.items();
          for (idx = 0, length = items.length; idx < length; idx++) {
            unbindElementTree(items[idx]);
          }
        },
        _ns: function(ns) {
          ns = ns || kendo.ui;
          var all = [kendo.ui, kendo.dataviz.ui, kendo.mobile.ui];
          all.splice($.inArray(ns, all), 1);
          all.unshift(ns);
          return kendo.rolesFromNamespaces(all);
        },
        dataBound: function(e) {
          var idx,
              length,
              widget = this.widget,
              items = e.addedItems || widget.items(),
              dataSource = widget[fieldName],
              view,
              parents,
              groups = dataSource.group() || [],
              hds = kendo.data.HierarchicalDataSource;
          if (hds && dataSource instanceof hds) {
            return ;
          }
          if (items.length) {
            view = e.addedDataItems || dataSource.flatView();
            parents = this.bindings[bindingName]._parents();
            for (idx = 0, length = view.length; idx < length; idx++) {
              bindElement(items[idx], view[idx], this._ns(e.ns), [view[idx]].concat(parents));
            }
          }
        },
        refresh: function(e) {
          var that = this,
              source,
              widget = that.widget;
          e = e || {};
          if (!e.action) {
            that.destroy();
            widget.bind("dataBinding", that._dataBinding);
            widget.bind("dataBound", that._dataBound);
            widget.bind("itemChange", that._itemChange);
            source = that.bindings[bindingName].get();
            if (widget[fieldName] instanceof kendo.data.DataSource && widget[fieldName] != source) {
              if (source instanceof kendo.data.DataSource) {
                widget[setter](source);
              } else if (source && source._dataSource) {
                widget[setter](source._dataSource);
              } else {
                widget[fieldName].data(source);
                if (that.bindings.value && (widget instanceof kendo.ui.Select || widget instanceof kendo.ui.MultiSelect)) {
                  widget.value(retrievePrimitiveValues(that.bindings.value.get(), widget.options.dataValueField));
                }
              }
            }
          }
        },
        destroy: function() {
          var widget = this.widget;
          widget.unbind("dataBinding", this._dataBinding);
          widget.unbind("dataBound", this._dataBound);
          widget.unbind("itemChange", this._itemChange);
        }
      });
    }
    binders.widget = {
      events: Binder.extend({
        init: function(widget, bindings, options) {
          Binder.fn.init.call(this, widget.element[0], bindings, options);
          this.widget = widget;
          this.handlers = {};
        },
        refresh: function(key) {
          var binding = this.bindings.events[key],
              handler = this.handlers[key];
          if (handler) {
            this.widget.unbind(key, handler);
          }
          handler = binding.get();
          this.handlers[key] = function(e) {
            e.data = binding.source;
            handler(e);
            if (e.data === binding.source) {
              delete e.data;
            }
          };
          this.widget.bind(key, this.handlers[key]);
        },
        destroy: function() {
          var handler;
          for (handler in this.handlers) {
            this.widget.unbind(handler, this.handlers[handler]);
          }
        }
      }),
      checked: Binder.extend({
        init: function(widget, bindings, options) {
          Binder.fn.init.call(this, widget.element[0], bindings, options);
          this.widget = widget;
          this._change = proxy(this.change, this);
          this.widget.bind(CHANGE, this._change);
        },
        change: function() {
          this.bindings[CHECKED].set(this.value());
        },
        refresh: function() {
          this.widget.check(this.bindings[CHECKED].get() === true);
        },
        value: function() {
          var element = this.element,
              value = element.value;
          if (value == "on" || value == "off") {
            value = element.checked;
          }
          return value;
        },
        destroy: function() {
          this.widget.unbind(CHANGE, this._change);
        }
      }),
      visible: Binder.extend({
        init: function(widget, bindings, options) {
          Binder.fn.init.call(this, widget.element[0], bindings, options);
          this.widget = widget;
        },
        refresh: function() {
          var visible = this.bindings.visible.get();
          this.widget.wrapper[0].style.display = visible ? "" : "none";
        }
      }),
      invisible: Binder.extend({
        init: function(widget, bindings, options) {
          Binder.fn.init.call(this, widget.element[0], bindings, options);
          this.widget = widget;
        },
        refresh: function() {
          var invisible = this.bindings.invisible.get();
          this.widget.wrapper[0].style.display = invisible ? "none" : "";
        }
      }),
      enabled: Binder.extend({
        init: function(widget, bindings, options) {
          Binder.fn.init.call(this, widget.element[0], bindings, options);
          this.widget = widget;
        },
        refresh: function() {
          if (this.widget.enable) {
            this.widget.enable(this.bindings.enabled.get());
          }
        }
      }),
      disabled: Binder.extend({
        init: function(widget, bindings, options) {
          Binder.fn.init.call(this, widget.element[0], bindings, options);
          this.widget = widget;
        },
        refresh: function() {
          if (this.widget.enable) {
            this.widget.enable(!this.bindings.disabled.get());
          }
        }
      }),
      source: dataSourceBinding("source", "dataSource", "setDataSource"),
      value: Binder.extend({
        init: function(widget, bindings, options) {
          Binder.fn.init.call(this, widget.element[0], bindings, options);
          this.widget = widget;
          this._change = $.proxy(this.change, this);
          this.widget.first(CHANGE, this._change);
          var value = this.bindings.value.get();
          this._valueIsObservableObject = !options.valuePrimitive && (value == null || value instanceof ObservableObject);
          this._valueIsObservableArray = value instanceof ObservableArray;
          this._initChange = false;
        },
        change: function() {
          var value = this.widget.value(),
              field = this.options.dataValueField || this.options.dataTextField,
              isArray = toString.call(value) === "[object Array]",
              isObservableObject = this._valueIsObservableObject,
              valueIndex,
              valueLength,
              values = [],
              sourceItem,
              sourceValue,
              idx,
              length,
              source;
          this._initChange = true;
          if (field) {
            if (this.bindings.source) {
              source = this.bindings.source.get();
            }
            if (value === "" && (isObservableObject || this.options.valuePrimitive)) {
              value = null;
            } else {
              if (!source || source instanceof kendo.data.DataSource) {
                source = this.widget.dataSource.flatView();
              }
              if (isArray) {
                valueLength = value.length;
                values = value.slice(0);
              }
              for (idx = 0, length = source.length; idx < length; idx++) {
                sourceItem = source[idx];
                sourceValue = sourceItem.get(field);
                if (isArray) {
                  for (valueIndex = 0; valueIndex < valueLength; valueIndex++) {
                    if (sourceValue == values[valueIndex]) {
                      values[valueIndex] = sourceItem;
                      break;
                    }
                  }
                } else if (sourceValue == value) {
                  value = isObservableObject ? sourceItem : sourceValue;
                  break;
                }
              }
              if (values[0]) {
                if (this._valueIsObservableArray) {
                  value = values;
                } else if (isObservableObject || !field) {
                  value = values[0];
                } else {
                  value = values[0].get(field);
                }
              }
            }
          }
          this.bindings.value.set(value);
          this._initChange = false;
        },
        refresh: function() {
          if (!this._initChange) {
            var widget = this.widget;
            var options = widget.options;
            var textField = options.dataTextField;
            var valueField = options.dataValueField || textField;
            var value = this.bindings.value.get();
            var text = options.text || "";
            var idx = 0,
                length;
            var values = [];
            if (value === undefined) {
              value = null;
            }
            if (valueField) {
              if (value instanceof ObservableArray) {
                for (length = value.length; idx < length; idx++) {
                  values[idx] = value[idx].get(valueField);
                }
                value = values;
              } else if (value instanceof ObservableObject) {
                text = value.get(textField);
                value = value.get(valueField);
              }
            }
            if (options.autoBind === false && !options.cascadeFrom && widget.listView && !widget.listView.isBound()) {
              if (textField === valueField && !text) {
                text = value;
              }
              if (!text && (value || value === 0) && options.valuePrimitive) {
                widget.value(value);
              } else {
                widget._preselect(value, text);
              }
            } else {
              widget.value(value);
            }
          }
          this._initChange = false;
        },
        destroy: function() {
          this.widget.unbind(CHANGE, this._change);
        }
      }),
      gantt: {dependencies: dataSourceBinding("dependencies", "dependencies", "setDependenciesDataSource")},
      multiselect: {value: Binder.extend({
          init: function(widget, bindings, options) {
            Binder.fn.init.call(this, widget.element[0], bindings, options);
            this.widget = widget;
            this._change = $.proxy(this.change, this);
            this.widget.first(CHANGE, this._change);
            this._initChange = false;
          },
          change: function() {
            var that = this,
                oldValues = that.bindings[VALUE].get(),
                valuePrimitive = that.options.valuePrimitive,
                newValues = valuePrimitive ? that.widget.value() : that.widget.dataItems();
            var field = this.options.dataValueField || this.options.dataTextField;
            newValues = newValues.slice(0);
            that._initChange = true;
            if (oldValues instanceof ObservableArray) {
              var remove = [];
              var newLength = newValues.length;
              var i = 0,
                  j = 0;
              var old = oldValues[i];
              var same = false;
              var removeIndex;
              var newValue;
              var found;
              while (old !== undefined) {
                found = false;
                for (j = 0; j < newLength; j++) {
                  if (valuePrimitive) {
                    same = newValues[j] == old;
                  } else {
                    newValue = newValues[j];
                    newValue = newValue.get ? newValue.get(field) : newValue;
                    same = newValue == (old.get ? old.get(field) : old);
                  }
                  if (same) {
                    newValues.splice(j, 1);
                    newLength -= 1;
                    found = true;
                    break;
                  }
                }
                if (!found) {
                  remove.push(old);
                  arraySplice(oldValues, i, 1);
                  removeIndex = i;
                } else {
                  i += 1;
                }
                old = oldValues[i];
              }
              arraySplice(oldValues, oldValues.length, 0, newValues);
              if (remove.length) {
                oldValues.trigger("change", {
                  action: "remove",
                  items: remove,
                  index: removeIndex
                });
              }
              if (newValues.length) {
                oldValues.trigger("change", {
                  action: "add",
                  items: newValues,
                  index: oldValues.length - 1
                });
              }
            } else {
              that.bindings[VALUE].set(newValues);
            }
            that._initChange = false;
          },
          refresh: function() {
            if (!this._initChange) {
              var options = this.options,
                  widget = this.widget,
                  field = options.dataValueField || options.dataTextField,
                  value = this.bindings.value.get(),
                  data = value,
                  idx = 0,
                  length,
                  values = [],
                  selectedValue;
              if (value === undefined) {
                value = null;
              }
              if (field) {
                if (value instanceof ObservableArray) {
                  for (length = value.length; idx < length; idx++) {
                    selectedValue = value[idx];
                    values[idx] = selectedValue.get ? selectedValue.get(field) : selectedValue;
                  }
                  value = values;
                } else if (value instanceof ObservableObject) {
                  value = value.get(field);
                }
              }
              if (options.autoBind === false && options.valuePrimitive !== true && !widget.listView.isBound()) {
                widget._preselect(data, value);
              } else {
                widget.value(value);
              }
            }
          },
          destroy: function() {
            this.widget.unbind(CHANGE, this._change);
          }
        })},
      scheduler: {source: dataSourceBinding("source", "dataSource", "setDataSource").extend({dataBound: function(e) {
            var idx;
            var length;
            var widget = this.widget;
            var elements = e.addedItems || widget.items();
            var data,
                parents;
            if (elements.length) {
              data = e.addedDataItems || widget.dataItems();
              parents = this.bindings.source._parents();
              for (idx = 0, length = data.length; idx < length; idx++) {
                bindElement(elements[idx], data[idx], this._ns(e.ns), [data[idx]].concat(parents));
              }
            }
          }})}
    };
    var arraySplice = function(arr, idx, remove, add) {
      add = add || [];
      remove = remove || 0;
      var addLength = add.length;
      var oldLength = arr.length;
      var shifted = [].slice.call(arr, idx + remove);
      var shiftedLength = shifted.length;
      var index;
      if (addLength) {
        addLength = idx + addLength;
        index = 0;
        for (; idx < addLength; idx++) {
          arr[idx] = add[index];
          index++;
        }
        arr.length = addLength;
      } else if (remove) {
        arr.length = idx;
        remove += idx;
        while (idx < remove) {
          delete arr[--remove];
        }
      }
      if (shiftedLength) {
        shiftedLength = idx + shiftedLength;
        index = 0;
        for (; idx < shiftedLength; idx++) {
          arr[idx] = shifted[index];
          index++;
        }
        arr.length = shiftedLength;
      }
      idx = arr.length;
      while (idx < oldLength) {
        delete arr[idx];
        idx++;
      }
    };
    var BindingTarget = Class.extend({
      init: function(target, options) {
        this.target = target;
        this.options = options;
        this.toDestroy = [];
      },
      bind: function(bindings) {
        var key,
            hasValue,
            hasSource,
            hasEvents,
            hasChecked,
            hasCss,
            widgetBinding = this instanceof WidgetBindingTarget,
            specificBinders = this.binders();
        for (key in bindings) {
          if (key == VALUE) {
            hasValue = true;
          } else if (key == SOURCE) {
            hasSource = true;
          } else if (key == EVENTS && !widgetBinding) {
            hasEvents = true;
          } else if (key == CHECKED) {
            hasChecked = true;
          } else if (key == CSS) {
            hasCss = true;
          } else {
            this.applyBinding(key, bindings, specificBinders);
          }
        }
        if (hasSource) {
          this.applyBinding(SOURCE, bindings, specificBinders);
        }
        if (hasValue) {
          this.applyBinding(VALUE, bindings, specificBinders);
        }
        if (hasChecked) {
          this.applyBinding(CHECKED, bindings, specificBinders);
        }
        if (hasEvents && !widgetBinding) {
          this.applyBinding(EVENTS, bindings, specificBinders);
        }
        if (hasCss && !widgetBinding) {
          this.applyBinding(CSS, bindings, specificBinders);
        }
      },
      binders: function() {
        return binders[this.target.nodeName.toLowerCase()] || {};
      },
      applyBinding: function(name, bindings, specificBinders) {
        var binder = specificBinders[name] || binders[name],
            toDestroy = this.toDestroy,
            attribute,
            binding = bindings[name];
        if (binder) {
          binder = new binder(this.target, bindings, this.options);
          toDestroy.push(binder);
          if (binding instanceof Binding) {
            binder.bind(binding);
            toDestroy.push(binding);
          } else {
            for (attribute in binding) {
              binder.bind(binding, attribute);
              toDestroy.push(binding[attribute]);
            }
          }
        } else if (name !== "template") {
          throw new Error("The " + name + " binding is not supported by the " + this.target.nodeName.toLowerCase() + " element");
        }
      },
      destroy: function() {
        var idx,
            length,
            toDestroy = this.toDestroy;
        for (idx = 0, length = toDestroy.length; idx < length; idx++) {
          toDestroy[idx].destroy();
        }
      }
    });
    var WidgetBindingTarget = BindingTarget.extend({
      binders: function() {
        return binders.widget[this.target.options.name.toLowerCase()] || {};
      },
      applyBinding: function(name, bindings, specificBinders) {
        var binder = specificBinders[name] || binders.widget[name],
            toDestroy = this.toDestroy,
            attribute,
            binding = bindings[name];
        if (binder) {
          binder = new binder(this.target, bindings, this.target.options);
          toDestroy.push(binder);
          if (binding instanceof Binding) {
            binder.bind(binding);
            toDestroy.push(binding);
          } else {
            for (attribute in binding) {
              binder.bind(binding, attribute);
              toDestroy.push(binding[attribute]);
            }
          }
        } else {
          throw new Error("The " + name + " binding is not supported by the " + this.target.options.name + " widget");
        }
      }
    });
    function bindingTargetForRole(element, roles) {
      var widget = kendo.initWidget(element, {}, roles);
      if (widget) {
        return new WidgetBindingTarget(widget);
      }
    }
    var keyValueRegExp = /[A-Za-z0-9_\-]+:(\{([^}]*)\}|[^,}]+)/g,
        whiteSpaceRegExp = /\s/g;
    function parseBindings(bind) {
      var result = {},
          idx,
          length,
          token,
          colonIndex,
          key,
          value,
          tokens;
      tokens = bind.match(keyValueRegExp);
      for (idx = 0, length = tokens.length; idx < length; idx++) {
        token = tokens[idx];
        colonIndex = token.indexOf(":");
        key = token.substring(0, colonIndex);
        value = token.substring(colonIndex + 1);
        if (value.charAt(0) == "{") {
          value = parseBindings(value);
        }
        result[key] = value;
      }
      return result;
    }
    function createBindings(bindings, source, type) {
      var binding,
          result = {};
      for (binding in bindings) {
        result[binding] = new type(source, bindings[binding]);
      }
      return result;
    }
    function bindElement(element, source, roles, parents) {
      var role = element.getAttribute("data-" + kendo.ns + "role"),
          idx,
          bind = element.getAttribute("data-" + kendo.ns + "bind"),
          children = element.children,
          childrenCopy = [],
          deep = true,
          bindings,
          options = {},
          target;
      parents = parents || [source];
      if (role || bind) {
        unbindElement(element);
      }
      if (role) {
        target = bindingTargetForRole(element, roles);
      }
      if (bind) {
        bind = parseBindings(bind.replace(whiteSpaceRegExp, ""));
        if (!target) {
          options = kendo.parseOptions(element, {
            textField: "",
            valueField: "",
            template: "",
            valueUpdate: CHANGE,
            valuePrimitive: false,
            autoBind: true
          });
          options.roles = roles;
          target = new BindingTarget(element, options);
        }
        target.source = source;
        bindings = createBindings(bind, parents, Binding);
        if (options.template) {
          bindings.template = new TemplateBinding(parents, "", options.template);
        }
        if (bindings.click) {
          bind.events = bind.events || {};
          bind.events.click = bind.click;
          bindings.click.destroy();
          delete bindings.click;
        }
        if (bindings.source) {
          deep = false;
        }
        if (bind.attr) {
          bindings.attr = createBindings(bind.attr, parents, Binding);
        }
        if (bind.style) {
          bindings.style = createBindings(bind.style, parents, Binding);
        }
        if (bind.events) {
          bindings.events = createBindings(bind.events, parents, EventBinding);
        }
        if (bind.css) {
          bindings.css = createBindings(bind.css, parents, Binding);
        }
        target.bind(bindings);
      }
      if (target) {
        element.kendoBindingTarget = target;
      }
      if (deep && children) {
        for (idx = 0; idx < children.length; idx++) {
          childrenCopy[idx] = children[idx];
        }
        for (idx = 0; idx < childrenCopy.length; idx++) {
          bindElement(childrenCopy[idx], source, roles, parents);
        }
      }
    }
    function bind(dom, object) {
      var idx,
          length,
          node,
          roles = kendo.rolesFromNamespaces([].slice.call(arguments, 2));
      object = kendo.observable(object);
      dom = $(dom);
      for (idx = 0, length = dom.length; idx < length; idx++) {
        node = dom[idx];
        if (node.nodeType === 1) {
          bindElement(node, object, roles);
        }
      }
    }
    function unbindElement(element) {
      var bindingTarget = element.kendoBindingTarget;
      if (bindingTarget) {
        bindingTarget.destroy();
        if (deleteExpando) {
          delete element.kendoBindingTarget;
        } else if (element.removeAttribute) {
          element.removeAttribute("kendoBindingTarget");
        } else {
          element.kendoBindingTarget = null;
        }
      }
    }
    function unbindElementTree(element) {
      unbindElement(element);
      unbindElementChildren(element);
    }
    function unbindElementChildren(element) {
      var children = element.children;
      if (children) {
        for (var idx = 0,
            length = children.length; idx < length; idx++) {
          unbindElementTree(children[idx]);
        }
      }
    }
    function unbind(dom) {
      var idx,
          length;
      dom = $(dom);
      for (idx = 0, length = dom.length; idx < length; idx++) {
        unbindElementTree(dom[idx]);
      }
    }
    function notify(widget, namespace) {
      var element = widget.element,
          bindingTarget = element[0].kendoBindingTarget;
      if (bindingTarget) {
        bind(element, bindingTarget.source, namespace);
      }
    }
    function retrievePrimitiveValues(value, valueField) {
      var values = [];
      var idx = 0;
      var length;
      var item;
      if (!valueField) {
        return value;
      }
      if (value instanceof ObservableArray) {
        for (length = value.length; idx < length; idx++) {
          item = value[idx];
          values[idx] = item.get ? item.get(valueField) : item[valueField];
        }
        value = values;
      } else if (value instanceof ObservableObject) {
        value = value.get(valueField);
      }
      return value;
    }
    kendo.unbind = unbind;
    kendo.bind = bind;
    kendo.data.binders = binders;
    kendo.data.Binder = Binder;
    kendo.notify = notify;
    kendo.observable = function(object) {
      if (!(object instanceof ObservableObject)) {
        object = new ObservableObject(object);
      }
      return object;
    };
    kendo.observableHierarchy = function(array) {
      var dataSource = kendo.data.HierarchicalDataSource.create(array);
      function recursiveRead(data) {
        var i,
            children;
        for (i = 0; i < data.length; i++) {
          data[i]._initChildren();
          children = data[i].children;
          children.fetch();
          data[i].items = children.data();
          recursiveRead(data[i].items);
        }
      }
      dataSource.fetch();
      recursiveRead(dataSource.data());
      dataSource._data._dataSource = dataSource;
      return dataSource._data;
    };
  })(window.kendo.jQuery);
  return window.kendo;
}, typeof define == 'function' && define.amd ? define : function(_, f) {
  f();
});
})();
(function() {
function define(){};  define.amd = {};
(function(f, define) {
  define(["./kendo.core"], f);
})(function() {
  (function($, undefined) {
    var kendo = window.kendo,
        fx = kendo.effects,
        each = $.each,
        extend = $.extend,
        proxy = $.proxy,
        support = kendo.support,
        browser = support.browser,
        transforms = support.transforms,
        transitions = support.transitions,
        scaleProperties = {
          scale: 0,
          scalex: 0,
          scaley: 0,
          scale3d: 0
        },
        translateProperties = {
          translate: 0,
          translatex: 0,
          translatey: 0,
          translate3d: 0
        },
        hasZoom = (typeof document.documentElement.style.zoom !== "undefined") && !transforms,
        matrix3dRegExp = /matrix3?d?\s*\(.*,\s*([\d\.\-]+)\w*?,\s*([\d\.\-]+)\w*?,\s*([\d\.\-]+)\w*?,\s*([\d\.\-]+)\w*?/i,
        cssParamsRegExp = /^(-?[\d\.\-]+)?[\w\s]*,?\s*(-?[\d\.\-]+)?[\w\s]*/i,
        translateXRegExp = /translatex?$/i,
        oldEffectsRegExp = /(zoom|fade|expand)(\w+)/,
        singleEffectRegExp = /(zoom|fade|expand)/,
        unitRegExp = /[xy]$/i,
        transformProps = ["perspective", "rotate", "rotatex", "rotatey", "rotatez", "rotate3d", "scale", "scalex", "scaley", "scalez", "scale3d", "skew", "skewx", "skewy", "translate", "translatex", "translatey", "translatez", "translate3d", "matrix", "matrix3d"],
        transform2d = ["rotate", "scale", "scalex", "scaley", "skew", "skewx", "skewy", "translate", "translatex", "translatey", "matrix"],
        transform2units = {
          "rotate": "deg",
          scale: "",
          skew: "px",
          translate: "px"
        },
        cssPrefix = transforms.css,
        round = Math.round,
        BLANK = "",
        PX = "px",
        NONE = "none",
        AUTO = "auto",
        WIDTH = "width",
        HEIGHT = "height",
        HIDDEN = "hidden",
        ORIGIN = "origin",
        ABORT_ID = "abortId",
        OVERFLOW = "overflow",
        TRANSLATE = "translate",
        POSITION = "position",
        COMPLETE_CALLBACK = "completeCallback",
        TRANSITION = cssPrefix + "transition",
        TRANSFORM = cssPrefix + "transform",
        BACKFACE = cssPrefix + "backface-visibility",
        PERSPECTIVE = cssPrefix + "perspective",
        DEFAULT_PERSPECTIVE = "1500px",
        TRANSFORM_PERSPECTIVE = "perspective(" + DEFAULT_PERSPECTIVE + ")",
        ios7 = support.mobileOS && support.mobileOS.majorVersion == 7,
        directions = {
          left: {
            reverse: "right",
            property: "left",
            transition: "translatex",
            vertical: false,
            modifier: -1
          },
          right: {
            reverse: "left",
            property: "left",
            transition: "translatex",
            vertical: false,
            modifier: 1
          },
          down: {
            reverse: "up",
            property: "top",
            transition: "translatey",
            vertical: true,
            modifier: 1
          },
          up: {
            reverse: "down",
            property: "top",
            transition: "translatey",
            vertical: true,
            modifier: -1
          },
          top: {reverse: "bottom"},
          bottom: {reverse: "top"},
          "in": {
            reverse: "out",
            modifier: -1
          },
          out: {
            reverse: "in",
            modifier: 1
          },
          vertical: {reverse: "vertical"},
          horizontal: {reverse: "horizontal"}
        };
    kendo.directions = directions;
    extend($.fn, {kendoStop: function(clearQueue, gotoEnd) {
        if (transitions) {
          return fx.stopQueue(this, clearQueue || false, gotoEnd || false);
        } else {
          return this.stop(clearQueue, gotoEnd);
        }
      }});
    if (transforms && !transitions) {
      each(transform2d, function(idx, value) {
        $.fn[value] = function(val) {
          if (typeof val == "undefined") {
            return animationProperty(this, value);
          } else {
            var that = $(this)[0],
                transformValue = value + "(" + val + transform2units[value.replace(unitRegExp, "")] + ")";
            if (that.style.cssText.indexOf(TRANSFORM) == -1) {
              $(this).css(TRANSFORM, transformValue);
            } else {
              that.style.cssText = that.style.cssText.replace(new RegExp(value + "\\(.*?\\)", "i"), transformValue);
            }
          }
          return this;
        };
        $.fx.step[value] = function(fx) {
          $(fx.elem)[value](fx.now);
        };
      });
      var curProxy = $.fx.prototype.cur;
      $.fx.prototype.cur = function() {
        if (transform2d.indexOf(this.prop) != -1) {
          return parseFloat($(this.elem)[this.prop]());
        }
        return curProxy.apply(this, arguments);
      };
    }
    kendo.toggleClass = function(element, classes, options, add) {
      if (classes) {
        classes = classes.split(" ");
        if (transitions) {
          options = extend({
            exclusive: "all",
            duration: 400,
            ease: "ease-out"
          }, options);
          element.css(TRANSITION, options.exclusive + " " + options.duration + "ms " + options.ease);
          setTimeout(function() {
            element.css(TRANSITION, "").css(HEIGHT);
          }, options.duration);
        }
        each(classes, function(idx, value) {
          element.toggleClass(value, add);
        });
      }
      return element;
    };
    kendo.parseEffects = function(input, mirror) {
      var effects = {};
      if (typeof input === "string") {
        each(input.split(" "), function(idx, value) {
          var redirectedEffect = !singleEffectRegExp.test(value),
              resolved = value.replace(oldEffectsRegExp, function(match, $1, $2) {
                return $1 + ":" + $2.toLowerCase();
              }),
              effect = resolved.split(":"),
              direction = effect[1],
              effectBody = {};
          if (effect.length > 1) {
            effectBody.direction = (mirror && redirectedEffect ? directions[direction].reverse : direction);
          }
          effects[effect[0]] = effectBody;
        });
      } else {
        each(input, function(idx) {
          var direction = this.direction;
          if (direction && mirror && !singleEffectRegExp.test(idx)) {
            this.direction = directions[direction].reverse;
          }
          effects[idx] = this;
        });
      }
      return effects;
    };
    function parseInteger(value) {
      return parseInt(value, 10);
    }
    function parseCSS(element, property) {
      return parseInteger(element.css(property));
    }
    function keys(obj) {
      var acc = [];
      for (var propertyName in obj) {
        acc.push(propertyName);
      }
      return acc;
    }
    function strip3DTransforms(properties) {
      for (var key in properties) {
        if (transformProps.indexOf(key) != -1 && transform2d.indexOf(key) == -1) {
          delete properties[key];
        }
      }
      return properties;
    }
    function normalizeCSS(element, properties) {
      var transformation = [],
          cssValues = {},
          lowerKey,
          key,
          value,
          isTransformed;
      for (key in properties) {
        lowerKey = key.toLowerCase();
        isTransformed = transforms && transformProps.indexOf(lowerKey) != -1;
        if (!support.hasHW3D && isTransformed && transform2d.indexOf(lowerKey) == -1) {
          delete properties[key];
        } else {
          value = properties[key];
          if (isTransformed) {
            transformation.push(key + "(" + value + ")");
          } else {
            cssValues[key] = value;
          }
        }
      }
      if (transformation.length) {
        cssValues[TRANSFORM] = transformation.join(" ");
      }
      return cssValues;
    }
    if (transitions) {
      extend(fx, {
        transition: function(element, properties, options) {
          var css,
              delay = 0,
              oldKeys = element.data("keys") || [],
              timeoutID;
          options = extend({
            duration: 200,
            ease: "ease-out",
            complete: null,
            exclusive: "all"
          }, options);
          var stopTransitionCalled = false;
          var stopTransition = function() {
            if (!stopTransitionCalled) {
              stopTransitionCalled = true;
              if (timeoutID) {
                clearTimeout(timeoutID);
                timeoutID = null;
              }
              element.removeData(ABORT_ID).dequeue().css(TRANSITION, "").css(TRANSITION);
              options.complete.call(element);
            }
          };
          options.duration = $.fx ? $.fx.speeds[options.duration] || options.duration : options.duration;
          css = normalizeCSS(element, properties);
          $.merge(oldKeys, keys(css));
          element.data("keys", $.unique(oldKeys)).height();
          element.css(TRANSITION, options.exclusive + " " + options.duration + "ms " + options.ease).css(TRANSITION);
          element.css(css).css(TRANSFORM);
          if (transitions.event) {
            element.one(transitions.event, stopTransition);
            if (options.duration !== 0) {
              delay = 500;
            }
          }
          timeoutID = setTimeout(stopTransition, options.duration + delay);
          element.data(ABORT_ID, timeoutID);
          element.data(COMPLETE_CALLBACK, stopTransition);
        },
        stopQueue: function(element, clearQueue, gotoEnd) {
          var cssValues,
              taskKeys = element.data("keys"),
              retainPosition = (!gotoEnd && taskKeys),
              completeCallback = element.data(COMPLETE_CALLBACK);
          if (retainPosition) {
            cssValues = kendo.getComputedStyles(element[0], taskKeys);
          }
          if (completeCallback) {
            completeCallback();
          }
          if (retainPosition) {
            element.css(cssValues);
          }
          return element.removeData("keys").stop(clearQueue);
        }
      });
    }
    function animationProperty(element, property) {
      if (transforms) {
        var transform = element.css(TRANSFORM);
        if (transform == NONE) {
          return property == "scale" ? 1 : 0;
        }
        var match = transform.match(new RegExp(property + "\\s*\\(([\\d\\w\\.]+)")),
            computed = 0;
        if (match) {
          computed = parseInteger(match[1]);
        } else {
          match = transform.match(matrix3dRegExp) || [0, 0, 0, 0, 0];
          property = property.toLowerCase();
          if (translateXRegExp.test(property)) {
            computed = parseFloat(match[3] / match[2]);
          } else if (property == "translatey") {
            computed = parseFloat(match[4] / match[2]);
          } else if (property == "scale") {
            computed = parseFloat(match[2]);
          } else if (property == "rotate") {
            computed = parseFloat(Math.atan2(match[2], match[1]));
          }
        }
        return computed;
      } else {
        return parseFloat(element.css(property));
      }
    }
    var EffectSet = kendo.Class.extend({
      init: function(element, options) {
        var that = this;
        that.element = element;
        that.effects = [];
        that.options = options;
        that.restore = [];
      },
      run: function(effects) {
        var that = this,
            effect,
            idx,
            jdx,
            length = effects.length,
            element = that.element,
            options = that.options,
            deferred = $.Deferred(),
            start = {},
            end = {},
            target,
            children,
            childrenLength;
        that.effects = effects;
        deferred.then($.proxy(that, "complete"));
        element.data("animating", true);
        for (idx = 0; idx < length; idx++) {
          effect = effects[idx];
          effect.setReverse(options.reverse);
          effect.setOptions(options);
          that.addRestoreProperties(effect.restore);
          effect.prepare(start, end);
          children = effect.children();
          for (jdx = 0, childrenLength = children.length; jdx < childrenLength; jdx++) {
            children[jdx].duration(options.duration).run();
          }
        }
        for (var effectName in options.effects) {
          extend(end, options.effects[effectName].properties);
        }
        if (!element.is(":visible")) {
          extend(start, {display: element.data("olddisplay") || "block"});
        }
        if (transforms && !options.reset) {
          target = element.data("targetTransform");
          if (target) {
            start = extend(target, start);
          }
        }
        start = normalizeCSS(element, start);
        if (transforms && !transitions) {
          start = strip3DTransforms(start);
        }
        element.css(start).css(TRANSFORM);
        for (idx = 0; idx < length; idx++) {
          effects[idx].setup();
        }
        if (options.init) {
          options.init();
        }
        element.data("targetTransform", end);
        fx.animate(element, end, extend({}, options, {complete: deferred.resolve}));
        return deferred.promise();
      },
      stop: function() {
        $(this.element).kendoStop(true, true);
      },
      addRestoreProperties: function(restore) {
        var element = this.element,
            value,
            i = 0,
            length = restore.length;
        for (; i < length; i++) {
          value = restore[i];
          this.restore.push(value);
          if (!element.data(value)) {
            element.data(value, element.css(value));
          }
        }
      },
      restoreCallback: function() {
        var element = this.element;
        for (var i = 0,
            length = this.restore.length; i < length; i++) {
          var value = this.restore[i];
          element.css(value, element.data(value));
        }
      },
      complete: function() {
        var that = this,
            idx = 0,
            element = that.element,
            options = that.options,
            effects = that.effects,
            length = effects.length;
        element.removeData("animating").dequeue();
        if (options.hide) {
          element.data("olddisplay", element.css("display")).hide();
        }
        this.restoreCallback();
        if (hasZoom && !transforms) {
          setTimeout($.proxy(this, "restoreCallback"), 0);
        }
        for (; idx < length; idx++) {
          effects[idx].teardown();
        }
        if (options.completeCallback) {
          options.completeCallback(element);
        }
      }
    });
    fx.promise = function(element, options) {
      var effects = [],
          effectClass,
          effectSet = new EffectSet(element, options),
          parsedEffects = kendo.parseEffects(options.effects),
          effect;
      options.effects = parsedEffects;
      for (var effectName in parsedEffects) {
        effectClass = fx[capitalize(effectName)];
        if (effectClass) {
          effect = new effectClass(element, parsedEffects[effectName].direction);
          effects.push(effect);
        }
      }
      if (effects[0]) {
        effectSet.run(effects);
      } else {
        if (!element.is(":visible")) {
          element.css({display: element.data("olddisplay") || "block"}).css("display");
        }
        if (options.init) {
          options.init();
        }
        element.dequeue();
        effectSet.complete();
      }
    };
    extend(fx, {animate: function(elements, properties, options) {
        var useTransition = options.transition !== false;
        delete options.transition;
        if (transitions && "transition" in fx && useTransition) {
          fx.transition(elements, properties, options);
        } else {
          if (transforms) {
            elements.animate(strip3DTransforms(properties), {
              queue: false,
              show: false,
              hide: false,
              duration: options.duration,
              complete: options.complete
            });
          } else {
            elements.each(function() {
              var element = $(this),
                  multiple = {};
              each(transformProps, function(idx, value) {
                var params,
                    currentValue = properties ? properties[value] + " " : null;
                if (currentValue) {
                  var single = properties;
                  if (value in scaleProperties && properties[value] !== undefined) {
                    params = currentValue.match(cssParamsRegExp);
                    if (transforms) {
                      extend(single, {scale: +params[0]});
                    }
                  } else {
                    if (value in translateProperties && properties[value] !== undefined) {
                      var position = element.css(POSITION),
                          isFixed = (position == "absolute" || position == "fixed");
                      if (!element.data(TRANSLATE)) {
                        if (isFixed) {
                          element.data(TRANSLATE, {
                            top: parseCSS(element, "top") || 0,
                            left: parseCSS(element, "left") || 0,
                            bottom: parseCSS(element, "bottom"),
                            right: parseCSS(element, "right")
                          });
                        } else {
                          element.data(TRANSLATE, {
                            top: parseCSS(element, "marginTop") || 0,
                            left: parseCSS(element, "marginLeft") || 0
                          });
                        }
                      }
                      var originalPosition = element.data(TRANSLATE);
                      params = currentValue.match(cssParamsRegExp);
                      if (params) {
                        var dX = value == TRANSLATE + "y" ? +null : +params[1],
                            dY = value == TRANSLATE + "y" ? +params[1] : +params[2];
                        if (isFixed) {
                          if (!isNaN(originalPosition.right)) {
                            if (!isNaN(dX)) {
                              extend(single, {right: originalPosition.right - dX});
                            }
                          } else {
                            if (!isNaN(dX)) {
                              extend(single, {left: originalPosition.left + dX});
                            }
                          }
                          if (!isNaN(originalPosition.bottom)) {
                            if (!isNaN(dY)) {
                              extend(single, {bottom: originalPosition.bottom - dY});
                            }
                          } else {
                            if (!isNaN(dY)) {
                              extend(single, {top: originalPosition.top + dY});
                            }
                          }
                        } else {
                          if (!isNaN(dX)) {
                            extend(single, {marginLeft: originalPosition.left + dX});
                          }
                          if (!isNaN(dY)) {
                            extend(single, {marginTop: originalPosition.top + dY});
                          }
                        }
                      }
                    }
                  }
                  if (!transforms && value != "scale" && value in single) {
                    delete single[value];
                  }
                  if (single) {
                    extend(multiple, single);
                  }
                }
              });
              if (browser.msie) {
                delete multiple.scale;
              }
              element.animate(multiple, {
                queue: false,
                show: false,
                hide: false,
                duration: options.duration,
                complete: options.complete
              });
            });
          }
        }
      }});
    fx.animatedPromise = fx.promise;
    var Effect = kendo.Class.extend({
      init: function(element, direction) {
        var that = this;
        that.element = element;
        that._direction = direction;
        that.options = {};
        that._additionalEffects = [];
        if (!that.restore) {
          that.restore = [];
        }
      },
      reverse: function() {
        this._reverse = true;
        return this.run();
      },
      play: function() {
        this._reverse = false;
        return this.run();
      },
      add: function(additional) {
        this._additionalEffects.push(additional);
        return this;
      },
      direction: function(value) {
        this._direction = value;
        return this;
      },
      duration: function(duration) {
        this._duration = duration;
        return this;
      },
      compositeRun: function() {
        var that = this,
            effectSet = new EffectSet(that.element, {
              reverse: that._reverse,
              duration: that._duration
            }),
            effects = that._additionalEffects.concat([that]);
        return effectSet.run(effects);
      },
      run: function() {
        if (this._additionalEffects && this._additionalEffects[0]) {
          return this.compositeRun();
        }
        var that = this,
            element = that.element,
            idx = 0,
            restore = that.restore,
            length = restore.length,
            value,
            deferred = $.Deferred(),
            start = {},
            end = {},
            target,
            children = that.children(),
            childrenLength = children.length;
        deferred.then($.proxy(that, "_complete"));
        element.data("animating", true);
        for (idx = 0; idx < length; idx++) {
          value = restore[idx];
          if (!element.data(value)) {
            element.data(value, element.css(value));
          }
        }
        for (idx = 0; idx < childrenLength; idx++) {
          children[idx].duration(that._duration).run();
        }
        that.prepare(start, end);
        if (!element.is(":visible")) {
          extend(start, {display: element.data("olddisplay") || "block"});
        }
        if (transforms) {
          target = element.data("targetTransform");
          if (target) {
            start = extend(target, start);
          }
        }
        start = normalizeCSS(element, start);
        if (transforms && !transitions) {
          start = strip3DTransforms(start);
        }
        element.css(start).css(TRANSFORM);
        that.setup();
        element.data("targetTransform", end);
        fx.animate(element, end, {
          duration: that._duration,
          complete: deferred.resolve
        });
        return deferred.promise();
      },
      stop: function() {
        var idx = 0,
            children = this.children(),
            childrenLength = children.length;
        for (idx = 0; idx < childrenLength; idx++) {
          children[idx].stop();
        }
        $(this.element).kendoStop(true, true);
        return this;
      },
      restoreCallback: function() {
        var element = this.element;
        for (var i = 0,
            length = this.restore.length; i < length; i++) {
          var value = this.restore[i];
          element.css(value, element.data(value));
        }
      },
      _complete: function() {
        var that = this,
            element = that.element;
        element.removeData("animating").dequeue();
        that.restoreCallback();
        if (that.shouldHide()) {
          element.data("olddisplay", element.css("display")).hide();
        }
        if (hasZoom && !transforms) {
          setTimeout($.proxy(that, "restoreCallback"), 0);
        }
        that.teardown();
      },
      setOptions: function(options) {
        extend(true, this.options, options);
      },
      children: function() {
        return [];
      },
      shouldHide: $.noop,
      setup: $.noop,
      prepare: $.noop,
      teardown: $.noop,
      directions: [],
      setReverse: function(reverse) {
        this._reverse = reverse;
        return this;
      }
    });
    function capitalize(word) {
      return word.charAt(0).toUpperCase() + word.substring(1);
    }
    function createEffect(name, definition) {
      var effectClass = Effect.extend(definition),
          directions = effectClass.prototype.directions;
      fx[capitalize(name)] = effectClass;
      fx.Element.prototype[name] = function(direction, opt1, opt2, opt3) {
        return new effectClass(this.element, direction, opt1, opt2, opt3);
      };
      each(directions, function(idx, theDirection) {
        fx.Element.prototype[name + capitalize(theDirection)] = function(opt1, opt2, opt3) {
          return new effectClass(this.element, theDirection, opt1, opt2, opt3);
        };
      });
    }
    var FOUR_DIRECTIONS = ["left", "right", "up", "down"],
        IN_OUT = ["in", "out"];
    createEffect("slideIn", {
      directions: FOUR_DIRECTIONS,
      divisor: function(value) {
        this.options.divisor = value;
        return this;
      },
      prepare: function(start, end) {
        var that = this,
            tmp,
            element = that.element,
            direction = directions[that._direction],
            offset = -direction.modifier * (direction.vertical ? element.outerHeight() : element.outerWidth()),
            startValue = offset / (that.options && that.options.divisor || 1) + PX,
            endValue = "0px";
        if (that._reverse) {
          tmp = start;
          start = end;
          end = tmp;
        }
        if (transforms) {
          start[direction.transition] = startValue;
          end[direction.transition] = endValue;
        } else {
          start[direction.property] = startValue;
          end[direction.property] = endValue;
        }
      }
    });
    createEffect("tile", {
      directions: FOUR_DIRECTIONS,
      init: function(element, direction, previous) {
        Effect.prototype.init.call(this, element, direction);
        this.options = {previous: previous};
      },
      previousDivisor: function(value) {
        this.options.previousDivisor = value;
        return this;
      },
      children: function() {
        var that = this,
            reverse = that._reverse,
            previous = that.options.previous,
            divisor = that.options.previousDivisor || 1,
            dir = that._direction;
        var children = [kendo.fx(that.element).slideIn(dir).setReverse(reverse)];
        if (previous) {
          children.push(kendo.fx(previous).slideIn(directions[dir].reverse).divisor(divisor).setReverse(!reverse));
        }
        return children;
      }
    });
    function createToggleEffect(name, property, defaultStart, defaultEnd) {
      createEffect(name, {
        directions: IN_OUT,
        startValue: function(value) {
          this._startValue = value;
          return this;
        },
        endValue: function(value) {
          this._endValue = value;
          return this;
        },
        shouldHide: function() {
          return this._shouldHide;
        },
        prepare: function(start, end) {
          var that = this,
              startValue,
              endValue,
              out = this._direction === "out",
              startDataValue = that.element.data(property),
              startDataValueIsSet = !(isNaN(startDataValue) || startDataValue == defaultStart);
          if (startDataValueIsSet) {
            startValue = startDataValue;
          } else if (typeof this._startValue !== "undefined") {
            startValue = this._startValue;
          } else {
            startValue = out ? defaultStart : defaultEnd;
          }
          if (typeof this._endValue !== "undefined") {
            endValue = this._endValue;
          } else {
            endValue = out ? defaultEnd : defaultStart;
          }
          if (this._reverse) {
            start[property] = endValue;
            end[property] = startValue;
          } else {
            start[property] = startValue;
            end[property] = endValue;
          }
          that._shouldHide = end[property] === defaultEnd;
        }
      });
    }
    createToggleEffect("fade", "opacity", 1, 0);
    createToggleEffect("zoom", "scale", 1, 0.01);
    createEffect("slideMargin", {prepare: function(start, end) {
        var that = this,
            element = that.element,
            options = that.options,
            origin = element.data(ORIGIN),
            offset = options.offset,
            margin,
            reverse = that._reverse;
        if (!reverse && origin === null) {
          element.data(ORIGIN, parseFloat(element.css("margin-" + options.axis)));
        }
        margin = (element.data(ORIGIN) || 0);
        end["margin-" + options.axis] = !reverse ? margin + offset : margin;
      }});
    createEffect("slideTo", {prepare: function(start, end) {
        var that = this,
            element = that.element,
            options = that.options,
            offset = options.offset.split(","),
            reverse = that._reverse;
        if (transforms) {
          end.translatex = !reverse ? offset[0] : 0;
          end.translatey = !reverse ? offset[1] : 0;
        } else {
          end.left = !reverse ? offset[0] : 0;
          end.top = !reverse ? offset[1] : 0;
        }
        element.css("left");
      }});
    createEffect("expand", {
      directions: ["horizontal", "vertical"],
      restore: [OVERFLOW],
      prepare: function(start, end) {
        var that = this,
            element = that.element,
            options = that.options,
            reverse = that._reverse,
            property = that._direction === "vertical" ? HEIGHT : WIDTH,
            setLength = element[0].style[property],
            oldLength = element.data(property),
            length = parseFloat(oldLength || setLength),
            realLength = round(element.css(property, AUTO)[property]());
        start.overflow = HIDDEN;
        length = (options && options.reset) ? realLength || length : length || realLength;
        end[property] = (reverse ? 0 : length) + PX;
        start[property] = (reverse ? length : 0) + PX;
        if (oldLength === undefined) {
          element.data(property, setLength);
        }
      },
      shouldHide: function() {
        return this._reverse;
      },
      teardown: function() {
        var that = this,
            element = that.element,
            property = that._direction === "vertical" ? HEIGHT : WIDTH,
            length = element.data(property);
        if (length == AUTO || length === BLANK) {
          setTimeout(function() {
            element.css(property, AUTO).css(property);
          }, 0);
        }
      }
    });
    var TRANSFER_START_STATE = {
      position: "absolute",
      marginLeft: 0,
      marginTop: 0,
      scale: 1
    };
    createEffect("transfer", {
      init: function(element, target) {
        this.element = element;
        this.options = {target: target};
        this.restore = [];
      },
      setup: function() {
        this.element.appendTo(document.body);
      },
      prepare: function(start, end) {
        var that = this,
            element = that.element,
            outerBox = fx.box(element),
            innerBox = fx.box(that.options.target),
            currentScale = animationProperty(element, "scale"),
            scale = fx.fillScale(innerBox, outerBox),
            transformOrigin = fx.transformOrigin(innerBox, outerBox);
        extend(start, TRANSFER_START_STATE);
        end.scale = 1;
        element.css(TRANSFORM, "scale(1)").css(TRANSFORM);
        element.css(TRANSFORM, "scale(" + currentScale + ")");
        start.top = outerBox.top;
        start.left = outerBox.left;
        start.transformOrigin = transformOrigin.x + PX + " " + transformOrigin.y + PX;
        if (that._reverse) {
          start.scale = scale;
        } else {
          end.scale = scale;
        }
      }
    });
    var CLIPS = {
      top: "rect(auto auto $size auto)",
      bottom: "rect($size auto auto auto)",
      left: "rect(auto $size auto auto)",
      right: "rect(auto auto auto $size)"
    };
    var ROTATIONS = {
      top: {
        start: "rotatex(0deg)",
        end: "rotatex(180deg)"
      },
      bottom: {
        start: "rotatex(-180deg)",
        end: "rotatex(0deg)"
      },
      left: {
        start: "rotatey(0deg)",
        end: "rotatey(-180deg)"
      },
      right: {
        start: "rotatey(180deg)",
        end: "rotatey(0deg)"
      }
    };
    function clipInHalf(container, direction) {
      var vertical = kendo.directions[direction].vertical,
          size = (container[vertical ? HEIGHT : WIDTH]() / 2) + "px";
      return CLIPS[direction].replace("$size", size);
    }
    createEffect("turningPage", {
      directions: FOUR_DIRECTIONS,
      init: function(element, direction, container) {
        Effect.prototype.init.call(this, element, direction);
        this._container = container;
      },
      prepare: function(start, end) {
        var that = this,
            reverse = that._reverse,
            direction = reverse ? directions[that._direction].reverse : that._direction,
            rotation = ROTATIONS[direction];
        start.zIndex = 1;
        if (that._clipInHalf) {
          start.clip = clipInHalf(that._container, kendo.directions[direction].reverse);
        }
        start[BACKFACE] = HIDDEN;
        end[TRANSFORM] = TRANSFORM_PERSPECTIVE + (reverse ? rotation.start : rotation.end);
        start[TRANSFORM] = TRANSFORM_PERSPECTIVE + (reverse ? rotation.end : rotation.start);
      },
      setup: function() {
        this._container.append(this.element);
      },
      face: function(value) {
        this._face = value;
        return this;
      },
      shouldHide: function() {
        var that = this,
            reverse = that._reverse,
            face = that._face;
        return (reverse && !face) || (!reverse && face);
      },
      clipInHalf: function(value) {
        this._clipInHalf = value;
        return this;
      },
      temporary: function() {
        this.element.addClass('temp-page');
        return this;
      }
    });
    createEffect("staticPage", {
      directions: FOUR_DIRECTIONS,
      init: function(element, direction, container) {
        Effect.prototype.init.call(this, element, direction);
        this._container = container;
      },
      restore: ["clip"],
      prepare: function(start, end) {
        var that = this,
            direction = that._reverse ? directions[that._direction].reverse : that._direction;
        start.clip = clipInHalf(that._container, direction);
        start.opacity = 0.999;
        end.opacity = 1;
      },
      shouldHide: function() {
        var that = this,
            reverse = that._reverse,
            face = that._face;
        return (reverse && !face) || (!reverse && face);
      },
      face: function(value) {
        this._face = value;
        return this;
      }
    });
    createEffect("pageturn", {
      directions: ["horizontal", "vertical"],
      init: function(element, direction, face, back) {
        Effect.prototype.init.call(this, element, direction);
        this.options = {};
        this.options.face = face;
        this.options.back = back;
      },
      children: function() {
        var that = this,
            options = that.options,
            direction = that._direction === "horizontal" ? "left" : "top",
            reverseDirection = kendo.directions[direction].reverse,
            reverse = that._reverse,
            temp,
            faceClone = options.face.clone(true).removeAttr("id"),
            backClone = options.back.clone(true).removeAttr("id"),
            element = that.element;
        if (reverse) {
          temp = direction;
          direction = reverseDirection;
          reverseDirection = temp;
        }
        return [kendo.fx(options.face).staticPage(direction, element).face(true).setReverse(reverse), kendo.fx(options.back).staticPage(reverseDirection, element).setReverse(reverse), kendo.fx(faceClone).turningPage(direction, element).face(true).clipInHalf(true).temporary().setReverse(reverse), kendo.fx(backClone).turningPage(reverseDirection, element).clipInHalf(true).temporary().setReverse(reverse)];
      },
      prepare: function(start, end) {
        start[PERSPECTIVE] = DEFAULT_PERSPECTIVE;
        start.transformStyle = "preserve-3d";
        start.opacity = 0.999;
        end.opacity = 1;
      },
      teardown: function() {
        this.element.find(".temp-page").remove();
      }
    });
    createEffect("flip", {
      directions: ["horizontal", "vertical"],
      init: function(element, direction, face, back) {
        Effect.prototype.init.call(this, element, direction);
        this.options = {};
        this.options.face = face;
        this.options.back = back;
      },
      children: function() {
        var that = this,
            options = that.options,
            direction = that._direction === "horizontal" ? "left" : "top",
            reverseDirection = kendo.directions[direction].reverse,
            reverse = that._reverse,
            temp,
            element = that.element;
        if (reverse) {
          temp = direction;
          direction = reverseDirection;
          reverseDirection = temp;
        }
        return [kendo.fx(options.face).turningPage(direction, element).face(true).setReverse(reverse), kendo.fx(options.back).turningPage(reverseDirection, element).setReverse(reverse)];
      },
      prepare: function(start) {
        start[PERSPECTIVE] = DEFAULT_PERSPECTIVE;
        start.transformStyle = "preserve-3d";
      }
    });
    var RESTORE_OVERFLOW = !support.mobileOS.android;
    var IGNORE_TRANSITION_EVENT_SELECTOR = ".km-touch-scrollbar, .km-actionsheet-wrapper";
    createEffect("replace", {
      _before: $.noop,
      _after: $.noop,
      init: function(element, previous, transitionClass) {
        Effect.prototype.init.call(this, element);
        this._previous = $(previous);
        this._transitionClass = transitionClass;
      },
      duration: function() {
        throw new Error("The replace effect does not support duration setting; the effect duration may be customized through the transition class rule");
      },
      beforeTransition: function(callback) {
        this._before = callback;
        return this;
      },
      afterTransition: function(callback) {
        this._after = callback;
        return this;
      },
      _both: function() {
        return $().add(this._element).add(this._previous);
      },
      _containerClass: function() {
        var direction = this._direction,
            containerClass = "k-fx k-fx-start k-fx-" + this._transitionClass;
        if (direction) {
          containerClass += " k-fx-" + direction;
        }
        if (this._reverse) {
          containerClass += " k-fx-reverse";
        }
        return containerClass;
      },
      complete: function(e) {
        if (!this.deferred || (e && $(e.target).is(IGNORE_TRANSITION_EVENT_SELECTOR))) {
          return ;
        }
        var container = this.container;
        container.removeClass("k-fx-end").removeClass(this._containerClass()).off(transitions.event, this.completeProxy);
        this._previous.hide().removeClass("k-fx-current");
        this.element.removeClass("k-fx-next");
        if (RESTORE_OVERFLOW) {
          container.css(OVERFLOW, "");
        }
        if (!this.isAbsolute) {
          this._both().css(POSITION, "");
        }
        this.deferred.resolve();
        delete this.deferred;
      },
      run: function() {
        if (this._additionalEffects && this._additionalEffects[0]) {
          return this.compositeRun();
        }
        var that = this,
            element = that.element,
            previous = that._previous,
            container = element.parents().filter(previous.parents()).first(),
            both = that._both(),
            deferred = $.Deferred(),
            originalPosition = element.css(POSITION),
            originalOverflow;
        if (!container.length) {
          container = element.parent();
        }
        this.container = container;
        this.deferred = deferred;
        this.isAbsolute = originalPosition == "absolute";
        if (!this.isAbsolute) {
          both.css(POSITION, "absolute");
        }
        if (RESTORE_OVERFLOW) {
          originalOverflow = container.css(OVERFLOW);
          container.css(OVERFLOW, "hidden");
        }
        if (!transitions) {
          this.complete();
        } else {
          element.addClass("k-fx-hidden");
          container.addClass(this._containerClass());
          this.completeProxy = $.proxy(this, "complete");
          container.on(transitions.event, this.completeProxy);
          kendo.animationFrame(function() {
            element.removeClass("k-fx-hidden").addClass("k-fx-next");
            previous.css("display", "").addClass("k-fx-current");
            that._before(previous, element);
            kendo.animationFrame(function() {
              container.removeClass("k-fx-start").addClass("k-fx-end");
              that._after(previous, element);
            });
          });
        }
        return deferred.promise();
      },
      stop: function() {
        this.complete();
      }
    });
    var Animation = kendo.Class.extend({
      init: function() {
        var that = this;
        that._tickProxy = proxy(that._tick, that);
        that._started = false;
      },
      tick: $.noop,
      done: $.noop,
      onEnd: $.noop,
      onCancel: $.noop,
      start: function() {
        if (!this.enabled()) {
          return ;
        }
        if (!this.done()) {
          this._started = true;
          kendo.animationFrame(this._tickProxy);
        } else {
          this.onEnd();
        }
      },
      enabled: function() {
        return true;
      },
      cancel: function() {
        this._started = false;
        this.onCancel();
      },
      _tick: function() {
        var that = this;
        if (!that._started) {
          return ;
        }
        that.tick();
        if (!that.done()) {
          kendo.animationFrame(that._tickProxy);
        } else {
          that._started = false;
          that.onEnd();
        }
      }
    });
    var Transition = Animation.extend({
      init: function(options) {
        var that = this;
        extend(that, options);
        Animation.fn.init.call(that);
      },
      done: function() {
        return this.timePassed() >= this.duration;
      },
      timePassed: function() {
        return Math.min(this.duration, (new Date()) - this.startDate);
      },
      moveTo: function(options) {
        var that = this,
            movable = that.movable;
        that.initial = movable[that.axis];
        that.delta = options.location - that.initial;
        that.duration = typeof options.duration == "number" ? options.duration : 300;
        that.tick = that._easeProxy(options.ease);
        that.startDate = new Date();
        that.start();
      },
      _easeProxy: function(ease) {
        var that = this;
        return function() {
          that.movable.moveAxis(that.axis, ease(that.timePassed(), that.initial, that.delta, that.duration));
        };
      }
    });
    extend(Transition, {
      easeOutExpo: function(t, b, c, d) {
        return (t == d) ? b + c : c * (-Math.pow(2, -10 * t / d) + 1) + b;
      },
      easeOutBack: function(t, b, c, d, s) {
        s = 1.70158;
        return c * ((t = t / d - 1) * t * ((s + 1) * t + s) + 1) + b;
      }
    });
    fx.Animation = Animation;
    fx.Transition = Transition;
    fx.createEffect = createEffect;
    fx.box = function(element) {
      element = $(element);
      var result = element.offset();
      result.width = element.outerWidth();
      result.height = element.outerHeight();
      return result;
    };
    fx.transformOrigin = function(inner, outer) {
      var x = (inner.left - outer.left) * outer.width / (outer.width - inner.width),
          y = (inner.top - outer.top) * outer.height / (outer.height - inner.height);
      return {
        x: isNaN(x) ? 0 : x,
        y: isNaN(y) ? 0 : y
      };
    };
    fx.fillScale = function(inner, outer) {
      return Math.min(inner.width / outer.width, inner.height / outer.height);
    };
    fx.fitScale = function(inner, outer) {
      return Math.max(inner.width / outer.width, inner.height / outer.height);
    };
  })(window.kendo.jQuery);
  return window.kendo;
}, typeof define == 'function' && define.amd ? define : function(_, f) {
  f();
});
})();
(function() {
function define(){};  define.amd = {};
(function(f, define) {
  define(["./kendo.core"], f);
})(function() {
  (function($, undefined) {
    var proxy = $.proxy;
    var NS = ".kendoResponsivePanel";
    var OPEN = "open";
    var CLOSE = "close";
    var ACTIVATE_EVENTS = "click" + NS + " touchstart" + NS;
    var Widget = kendo.ui.Widget;
    var ResponsivePanel = Widget.extend({
      init: function(element, options) {
        Widget.fn.init.call(this, element, options);
        this._guid = "_" + kendo.guid();
        this._toggleHandler = proxy(this._toggleButtonClick, this);
        this._closeHandler = proxy(this._close, this);
        $(document.documentElement).on(ACTIVATE_EVENTS, this.options.toggleButton, this._toggleHandler);
        this._registerBreakpoint();
        this.element.addClass("k-rpanel k-rpanel-" + this.options.orientation + " " + this._guid);
        this._resizeHandler = proxy(this.resize, this, false);
        $(window).on("resize" + NS, this._resizeHandler);
      },
      _mediaQuery: "@media (max-width: #= breakpoint-1 #px) {" + ".#= guid #.k-rpanel-animate.k-rpanel-left," + ".#= guid #.k-rpanel-animate.k-rpanel-right {" + "-webkit-transition: -webkit-transform .2s ease-out;" + "-ms-transition: -ms-transform .2s ease-out;" + "transition: transform .2s ease-out;" + "} " + ".#= guid #.k-rpanel-top {" + "overflow: hidden;" + "}" + ".#= guid #.k-rpanel-animate.k-rpanel-top {" + "-webkit-transition: max-height .2s linear;" + "-ms-transition: max-height .2s linear;" + "transition: max-height .2s linear;" + "}" + "} " + "@media (min-width: #= breakpoint #px) {" + "#= toggleButton # { display: none; } " + ".#= guid #.k-rpanel-left { float: left; } " + ".#= guid #.k-rpanel-right { float: right; } " + ".#= guid #.k-rpanel-left, .#= guid #.k-rpanel-right {" + "position: relative;" + "-webkit-transform: translateX(0) translateZ(0);" + "-ms-transform: translateX(0) translateZ(0);" + "transform: translateX(0) translateZ(0);" + "} " + ".#= guid #.k-rpanel-top { max-height: none; }" + "}",
      _registerBreakpoint: function() {
        var options = this.options;
        this._registerStyle(kendo.template(this._mediaQuery)({
          breakpoint: options.breakpoint,
          toggleButton: options.toggleButton,
          guid: this._guid
        }));
      },
      _registerStyle: function(cssText) {
        var head = $("head,body")[0];
        var style = document.createElement('style');
        head.appendChild(style);
        if (style.styleSheet) {
          style.styleSheet.cssText = cssText;
        } else {
          style.appendChild(document.createTextNode(cssText));
        }
      },
      options: {
        name: "ResponsivePanel",
        orientation: "left",
        toggleButton: ".k-rpanel-toggle",
        breakpoint: 640,
        autoClose: true
      },
      events: [OPEN, CLOSE],
      _resize: function() {
        this.element.removeClass("k-rpanel-animate");
      },
      _toggleButtonClick: function(e) {
        e.preventDefault();
        if (this.element.hasClass("k-rpanel-expanded")) {
          this.close();
        } else {
          this.open();
        }
      },
      open: function() {
        if (!this.trigger(OPEN)) {
          this.element.addClass("k-rpanel-animate k-rpanel-expanded");
          if (this.options.autoClose) {
            $(document.documentElement).on(ACTIVATE_EVENTS, this._closeHandler);
          }
        }
      },
      close: function() {
        if (!this.trigger(CLOSE)) {
          this.element.addClass("k-rpanel-animate").removeClass("k-rpanel-expanded");
          $(document.documentElement).off(ACTIVATE_EVENTS, this._closeHandler);
        }
      },
      _close: function(e) {
        var prevented = e.isDefaultPrevented();
        var container = $(e.target).closest(this.options.toggleButton + ",.k-rpanel");
        if (!container.length && !prevented) {
          this.close();
        }
      },
      destroy: function() {
        Widget.fn.destroy.call(this);
        $(window).off("resize" + NS, this._resizeHandler);
        $(document.documentElement).off(ACTIVATE_EVENTS, this._closeHandler);
      }
    });
    kendo.ui.plugin(ResponsivePanel);
  })(window.kendo.jQuery);
  return window.kendo;
}, typeof define == 'function' && define.amd ? define : function(_, f) {
  f();
});
})();
(function() {
function define(){};  define.amd = {};
(function(f, define) {
  define(["./kendo.list", "./kendo.mobile.scroller"], f);
})(function() {
  (function($, undefined) {
    var kendo = window.kendo,
        support = kendo.support,
        caret = kendo.caret,
        activeElement = kendo._activeElement,
        placeholderSupported = support.placeholder,
        ui = kendo.ui,
        List = ui.List,
        keys = kendo.keys,
        DataSource = kendo.data.DataSource,
        ARIA_DISABLED = "aria-disabled",
        ARIA_READONLY = "aria-readonly",
        DEFAULT = "k-state-default",
        DISABLED = "disabled",
        READONLY = "readonly",
        FOCUSED = "k-state-focused",
        SELECTED = "k-state-selected",
        STATEDISABLED = "k-state-disabled",
        HOVER = "k-state-hover",
        ns = ".kendoAutoComplete",
        HOVEREVENTS = "mouseenter" + ns + " mouseleave" + ns,
        proxy = $.proxy;
    function indexOfWordAtCaret(caretIdx, text, separator) {
      return separator ? text.substring(0, caretIdx).split(separator).length - 1 : 0;
    }
    function wordAtCaret(caretIdx, text, separator) {
      return text.split(separator)[indexOfWordAtCaret(caretIdx, text, separator)];
    }
    function replaceWordAtCaret(caretIdx, text, word, separator) {
      var words = text.split(separator);
      words.splice(indexOfWordAtCaret(caretIdx, text, separator), 1, word);
      if (separator && words[words.length - 1] !== "") {
        words.push("");
      }
      return words.join(separator);
    }
    var AutoComplete = List.extend({
      init: function(element, options) {
        var that = this,
            wrapper,
            disabled;
        that.ns = ns;
        options = $.isArray(options) ? {dataSource: options} : options;
        List.fn.init.call(that, element, options);
        element = that.element;
        options = that.options;
        options.placeholder = options.placeholder || element.attr("placeholder");
        if (placeholderSupported) {
          element.attr("placeholder", options.placeholder);
        }
        that._wrapper();
        that._loader();
        that._dataSource();
        that._ignoreCase();
        element[0].type = "text";
        wrapper = that.wrapper;
        that._popup();
        element.addClass("k-input").on("keydown" + ns, proxy(that._keydown, that)).on("paste" + ns, proxy(that._search, that)).on("focus" + ns, function() {
          that._prev = that._accessor();
          that._placeholder(false);
          wrapper.addClass(FOCUSED);
        }).on("focusout" + ns, function() {
          that._change();
          that._placeholder();
          wrapper.removeClass(FOCUSED);
        }).attr({
          autocomplete: "off",
          role: "textbox",
          "aria-haspopup": true
        });
        that._enable();
        that._old = that._accessor();
        if (element[0].id) {
          element.attr("aria-owns", that.ul[0].id);
        }
        that._aria();
        that._placeholder();
        that._initList();
        disabled = $(that.element).parents("fieldset").is(':disabled');
        if (disabled) {
          that.enable(false);
        }
        kendo.notify(that);
      },
      options: {
        name: "AutoComplete",
        enabled: true,
        suggest: false,
        template: "",
        groupTemplate: "#:data#",
        fixedGroupTemplate: "#:data#",
        dataTextField: "",
        minLength: 1,
        delay: 200,
        height: 200,
        filter: "startswith",
        ignoreCase: true,
        highlightFirst: false,
        separator: null,
        placeholder: "",
        animation: {},
        value: null
      },
      _dataSource: function() {
        var that = this;
        if (that.dataSource && that._refreshHandler) {
          that._unbindDataSource();
        } else {
          that._progressHandler = proxy(that._showBusy, that);
        }
        that.dataSource = DataSource.create(that.options.dataSource).bind("progress", that._progressHandler);
      },
      setDataSource: function(dataSource) {
        this.options.dataSource = dataSource;
        this._dataSource();
        this.listView.setDataSource(this.dataSource);
      },
      events: ["open", "close", "change", "select", "filtering", "dataBinding", "dataBound"],
      setOptions: function(options) {
        var listOptions = this._listOptions(options);
        List.fn.setOptions.call(this, options);
        listOptions.dataValueField = listOptions.dataTextField;
        this.listView.setOptions(listOptions);
        this._accessors();
        this._aria();
      },
      _editable: function(options) {
        var that = this,
            element = that.element,
            wrapper = that.wrapper.off(ns),
            readonly = options.readonly,
            disable = options.disable;
        if (!readonly && !disable) {
          wrapper.addClass(DEFAULT).removeClass(STATEDISABLED).on(HOVEREVENTS, that._toggleHover);
          element.removeAttr(DISABLED).removeAttr(READONLY).attr(ARIA_DISABLED, false).attr(ARIA_READONLY, false);
        } else {
          wrapper.addClass(disable ? STATEDISABLED : DEFAULT).removeClass(disable ? DEFAULT : STATEDISABLED);
          element.attr(DISABLED, disable).attr(READONLY, readonly).attr(ARIA_DISABLED, disable).attr(ARIA_READONLY, readonly);
        }
      },
      close: function() {
        var that = this;
        var current = that.listView.focus();
        if (current) {
          current.removeClass(SELECTED);
        }
        that.popup.close();
      },
      destroy: function() {
        var that = this;
        that.element.off(ns);
        that.wrapper.off(ns);
        List.fn.destroy.call(that);
      },
      refresh: function() {
        this.listView.refresh();
      },
      select: function(li) {
        this._select(li);
      },
      search: function(word) {
        var that = this,
            options = that.options,
            ignoreCase = options.ignoreCase,
            separator = options.separator,
            length;
        word = word || that._accessor();
        clearTimeout(that._typingTimeout);
        if (separator) {
          word = wordAtCaret(caret(that.element)[0], word, separator);
        }
        length = word.length;
        if (!length || length >= options.minLength) {
          that._open = true;
          that.listView.filter(true);
          that._filterSource({
            value: ignoreCase ? word.toLowerCase() : word,
            operator: options.filter,
            field: options.dataTextField,
            ignoreCase: ignoreCase
          });
        }
      },
      suggest: function(word) {
        var that = this,
            key = that._last,
            value = that._accessor(),
            element = that.element[0],
            caretIdx = caret(element)[0],
            separator = that.options.separator,
            words = value.split(separator),
            wordIndex = indexOfWordAtCaret(caretIdx, value, separator),
            selectionEnd = caretIdx,
            idx;
        if (key == keys.BACKSPACE || key == keys.DELETE) {
          that._last = undefined;
          return ;
        }
        word = word || "";
        if (typeof word !== "string") {
          if (word[0]) {
            word = that.dataSource.view()[List.inArray(word[0], that.ul[0])];
          }
          word = word ? that._text(word) : "";
        }
        if (caretIdx <= 0) {
          caretIdx = value.toLowerCase().indexOf(word.toLowerCase()) + 1;
        }
        idx = value.substring(0, caretIdx).lastIndexOf(separator);
        idx = idx > -1 ? caretIdx - (idx + separator.length) : caretIdx;
        value = words[wordIndex].substring(0, idx);
        if (word) {
          word = word.toString();
          idx = word.toLowerCase().indexOf(value.toLowerCase());
          if (idx > -1) {
            word = word.substring(idx + value.length);
            selectionEnd = caretIdx + word.length;
            value += word;
          }
          if (separator && words[words.length - 1] !== "") {
            words.push("");
          }
        }
        words[wordIndex] = value;
        that._accessor(words.join(separator || ""));
        if (element === activeElement()) {
          caret(element, caretIdx, selectionEnd);
        }
      },
      value: function(value) {
        if (value !== undefined) {
          this.listView.value(value);
          this._accessor(value);
          this._old = this._accessor();
        } else {
          return this._accessor();
        }
      },
      _click: function(e) {
        var item = e.item;
        var element = this.element;
        if (this.trigger("select", {item: item})) {
          this.close();
          return ;
        }
        this._select(item);
        this._blur();
        caret(element, element.val().length);
      },
      _initList: function() {
        var that = this;
        var virtual = that.options.virtual;
        var hasVirtual = !!virtual;
        var listBoundHandler = proxy(that._listBound, that);
        var listOptions = {
          autoBind: false,
          selectable: true,
          dataSource: that.dataSource,
          click: $.proxy(that._click, this),
          change: $.proxy(that._listChange, this),
          activate: proxy(that._activateItem, that),
          deactivate: proxy(that._deactivateItem, that),
          dataBinding: function() {
            that.trigger("dataBinding");
            that._angularItems("cleanup");
          },
          dataBound: listBoundHandler,
          listBound: listBoundHandler
        };
        listOptions = $.extend(that._listOptions(), listOptions, typeof virtual === "object" ? virtual : {});
        listOptions.dataValueField = listOptions.dataTextField;
        if (!hasVirtual) {
          that.listView = new kendo.ui.StaticList(that.ul, listOptions);
        } else {
          that.listView = new kendo.ui.VirtualList(that.ul, listOptions);
        }
        that.listView.value(that.options.value);
      },
      _listBound: function() {
        var that = this;
        var popup = that.popup;
        var options = that.options;
        var data = that.dataSource.flatView();
        var length = data.length;
        var isActive = that.element[0] === activeElement();
        var action;
        that._angularItems("compile");
        that.listView.value([]);
        that.listView.focus(-1);
        that.listView.filter(false);
        that._calculateGroupPadding(that._height(length));
        popup.position();
        if (length) {
          var current = this.listView.focus();
          if (options.highlightFirst && !current) {
            that.listView.first();
          }
          if (options.suggest && isActive) {
            that.suggest(data[0]);
          }
        }
        if (that._open) {
          that._open = false;
          action = length ? "open" : "close";
          if (that._typingTimeout && !isActive) {
            action = "close";
          }
          popup[action]();
          that._typingTimeout = undefined;
        }
        if (that._touchScroller) {
          that._touchScroller.reset();
        }
        that._hideBusy();
        that._makeUnselectable();
        that.trigger("dataBound");
      },
      _listChange: function() {
        if (!this.listView.filter()) {
          this._selectValue(this.listView.selectedDataItems()[0]);
        }
      },
      _selectValue: function(dataItem) {
        var separator = this.options.separator;
        var text = "";
        if (dataItem) {
          text = this._text(dataItem);
        }
        if (text === null) {
          text = "";
        }
        if (separator) {
          text = replaceWordAtCaret(caret(this.element)[0], this._accessor(), text, separator);
        }
        this._prev = text;
        this._accessor(text);
        this._placeholder();
      },
      _accessor: function(value) {
        var that = this,
            element = that.element[0];
        if (value !== undefined) {
          element.value = value === null ? "" : value;
          that._placeholder();
        } else {
          value = element.value;
          if (element.className.indexOf("k-readonly") > -1) {
            if (value === that.options.placeholder) {
              return "";
            } else {
              return value;
            }
          }
          return value;
        }
      },
      _keydown: function(e) {
        var that = this;
        var key = e.keyCode;
        var visible = that.popup.visible();
        var current = this.listView.focus();
        that._last = key;
        if (key === keys.DOWN) {
          if (visible) {
            this._move(current ? "next" : "first");
          }
          e.preventDefault();
        } else if (key === keys.UP) {
          if (visible) {
            this._move(current ? "prev" : "last");
          }
          e.preventDefault();
        } else if (key === keys.ENTER || key === keys.TAB) {
          if (key === keys.ENTER && visible) {
            e.preventDefault();
          }
          if (visible && current) {
            if (that.trigger("select", {item: current})) {
              return ;
            }
            this._select(current);
          }
          this._blur();
        } else if (key === keys.ESC) {
          if (visible) {
            e.preventDefault();
          }
          that.close();
        } else {
          that._search();
          that._typing = true;
        }
      },
      _move: function(action) {
        this.listView[action]();
        if (this.options.suggest) {
          this.suggest(this.listView.focus());
        }
      },
      _hideBusy: function() {
        var that = this;
        clearTimeout(that._busy);
        that._loading.hide();
        that.element.attr("aria-busy", false);
        that._busy = null;
      },
      _showBusy: function() {
        var that = this;
        if (that._busy) {
          return ;
        }
        that._busy = setTimeout(function() {
          that.element.attr("aria-busy", true);
          that._loading.show();
        }, 100);
      },
      _placeholder: function(show) {
        if (placeholderSupported) {
          return ;
        }
        var that = this,
            element = that.element,
            placeholder = that.options.placeholder,
            value;
        if (placeholder) {
          value = element.val();
          if (show === undefined) {
            show = !value;
          }
          if (!show) {
            if (value !== placeholder) {
              placeholder = value;
            } else {
              placeholder = "";
            }
          }
          if (value === that._old && !show) {
            return ;
          }
          element.toggleClass("k-readonly", show).val(placeholder);
          if (!placeholder && element[0] === document.activeElement) {
            caret(element[0], 0, 0);
          }
        }
      },
      _search: function() {
        var that = this;
        clearTimeout(that._typingTimeout);
        that._typingTimeout = setTimeout(function() {
          if (that._prev !== that._accessor()) {
            that._prev = that._accessor();
            that.search();
          }
        }, that.options.delay);
      },
      _select: function(candidate) {
        this.listView.select(candidate);
      },
      _loader: function() {
        this._loading = $('<span class="k-icon k-loading" style="display:none"></span>').insertAfter(this.element);
      },
      _toggleHover: function(e) {
        $(e.currentTarget).toggleClass(HOVER, e.type === "mouseenter");
      },
      _wrapper: function() {
        var that = this,
            element = that.element,
            DOMelement = element[0],
            wrapper;
        wrapper = element.parent();
        if (!wrapper.is("span.k-widget")) {
          wrapper = element.wrap("<span />").parent();
        }
        wrapper.attr("tabindex", -1);
        wrapper.attr("role", "presentation");
        wrapper[0].style.cssText = DOMelement.style.cssText;
        element.css({
          width: "100%",
          height: DOMelement.style.height
        });
        that._focused = that.element;
        that.wrapper = wrapper.addClass("k-widget k-autocomplete k-header").addClass(DOMelement.className);
      }
    });
    ui.plugin(AutoComplete);
  })(window.kendo.jQuery);
  return window.kendo;
}, typeof define == 'function' && define.amd ? define : function(_, f) {
  f();
});
})();
(function() {
function define(){};  define.amd = {};
(function(f, define) {
  define(["./kendo.data", "./kendo.userevents", "./kendo.mobile.button"], f);
})(function() {
  (function($, undefined) {
    var kendo = window.kendo,
        Node = window.Node,
        mobile = kendo.mobile,
        ui = mobile.ui,
        DataSource = kendo.data.DataSource,
        Widget = ui.DataBoundWidget,
        ITEM_SELECTOR = ".km-list > li, > li:not(.km-group-container)",
        HIGHLIGHT_SELECTOR = ".km-listview-link, .km-listview-label",
        ICON_SELECTOR = "[" + kendo.attr("icon") + "]",
        proxy = $.proxy,
        attrValue = kendo.attrValue,
        GROUP_CLASS = "km-group-title",
        ACTIVE_CLASS = "km-state-active",
        GROUP_WRAPPER = '<div class="' + GROUP_CLASS + '"><div class="km-text"></div></div>',
        GROUP_TEMPLATE = kendo.template('<li><div class="' + GROUP_CLASS + '"><div class="km-text">#= this.headerTemplate(data) #</div></div><ul>#= kendo.render(this.template, data.items)#</ul></li>'),
        WRAPPER = '<div class="km-listview-wrapper" />',
        SEARCH_TEMPLATE = kendo.template('<form class="km-filter-form"><div class="km-filter-wrap"><input type="search" placeholder="#=placeholder#"/><a href="\\#" class="km-filter-reset" title="Clear"><span class="km-icon km-clear"></span><span class="km-text">Clear</span></a></div></form>'),
        NS = ".kendoMobileListView",
        STYLED = "styled",
        DATABOUND = "dataBound",
        DATABINDING = "dataBinding",
        ITEM_CHANGE = "itemChange",
        CLICK = "click",
        CHANGE = "change",
        PROGRESS = "progress",
        FUNCTION = "function",
        whitespaceRegExp = /^\s+$/,
        buttonRegExp = /button/;
    function whitespace() {
      return this.nodeType === Node.TEXT_NODE && this.nodeValue.match(whitespaceRegExp);
    }
    function addIcon(item, icon) {
      if (icon && !item[0].querySelector(".km-icon")) {
        item.prepend('<span class="km-icon km-' + icon + '"/>');
      }
    }
    function enhanceItem(item) {
      addIcon(item, attrValue(item, "icon"));
      addIcon(item, attrValue(item.children(ICON_SELECTOR), "icon"));
    }
    function enhanceLinkItem(item) {
      var parent = item.parent(),
          itemAndDetailButtons = item.add(parent.children(kendo.roleSelector("detailbutton"))),
          otherNodes = parent.contents().not(itemAndDetailButtons).not(whitespace);
      if (otherNodes.length) {
        return ;
      }
      item.addClass("km-listview-link").attr(kendo.attr("role"), "listview-link");
      addIcon(item, attrValue(parent, "icon"));
      addIcon(item, attrValue(item, "icon"));
    }
    function enhanceCheckBoxItem(label) {
      if (!label[0].querySelector("input[type=checkbox],input[type=radio]")) {
        return ;
      }
      var item = label.parent();
      if (item.contents().not(label).not(function() {
        return this.nodeType == 3;
      })[0]) {
        return ;
      }
      label.addClass("km-listview-label");
      label.children("[type=checkbox],[type=radio]").addClass("km-widget km-icon km-check");
    }
    function putAt(element, top) {
      $(element).css('transform', 'translate3d(0px, ' + top + 'px, 0px)');
    }
    var HeaderFixer = kendo.Class.extend({
      init: function(listView) {
        var scroller = listView.scroller();
        if (!scroller) {
          return ;
        }
        this.options = listView.options;
        this.element = listView.element;
        this.scroller = listView.scroller();
        this._shouldFixHeaders();
        var headerFixer = this;
        var cacheHeaders = function() {
          headerFixer._cacheHeaders();
        };
        listView.bind("resize", cacheHeaders);
        listView.bind(STYLED, cacheHeaders);
        listView.bind(DATABOUND, cacheHeaders);
        scroller.bind("scroll", function(e) {
          headerFixer._fixHeader(e);
        });
      },
      _fixHeader: function(e) {
        if (!this.fixedHeaders) {
          return ;
        }
        var i = 0,
            scroller = this.scroller,
            headers = this.headers,
            scrollTop = e.scrollTop,
            headerPair,
            offset,
            header;
        do {
          headerPair = headers[i++];
          if (!headerPair) {
            header = $("<div />");
            break;
          }
          offset = headerPair.offset;
          header = headerPair.header;
        } while (offset + 1 > scrollTop);
        if (this.currentHeader != i) {
          scroller.fixedContainer.html(header.clone());
          this.currentHeader = i;
        }
      },
      _shouldFixHeaders: function() {
        this.fixedHeaders = this.options.type === "group" && this.options.fixedHeaders;
      },
      _cacheHeaders: function() {
        this._shouldFixHeaders();
        if (!this.fixedHeaders) {
          return ;
        }
        var headers = [],
            offset = this.scroller.scrollTop;
        this.element.find("." + GROUP_CLASS).each(function(_, header) {
          header = $(header);
          headers.unshift({
            offset: header.position().top + offset,
            header: header
          });
        });
        this.headers = headers;
        this._fixHeader({scrollTop: offset});
      }
    });
    var DEFAULT_PULL_PARAMETERS = function() {
      return {page: 1};
    };
    var RefreshHandler = kendo.Class.extend({
      init: function(listView) {
        var handler = this,
            options = listView.options,
            scroller = listView.scroller(),
            pullParameters = options.pullParameters || DEFAULT_PULL_PARAMETERS;
        this.listView = listView;
        this.scroller = scroller;
        listView.bind("_dataSource", function(e) {
          handler.setDataSource(e.dataSource);
        });
        scroller.setOptions({
          pullToRefresh: true,
          pull: function() {
            if (!handler._pulled) {
              handler._pulled = true;
              handler.dataSource.read(pullParameters.call(listView, handler._first));
            }
          },
          messages: {
            pullTemplate: options.messages.pullTemplate,
            releaseTemplate: options.messages.releaseTemplate,
            refreshTemplate: options.messages.refreshTemplate
          }
        });
      },
      setDataSource: function(dataSource) {
        var handler = this;
        this._first = dataSource.view()[0];
        this.dataSource = dataSource;
        dataSource.bind("change", function() {
          handler._change();
        });
        dataSource.bind("error", function() {
          handler._change();
        });
      },
      _change: function() {
        var scroller = this.scroller,
            dataSource = this.dataSource;
        if (this._pulled) {
          scroller.pullHandled();
        }
        if (this._pulled || !this._first) {
          var view = dataSource.view();
          if (view[0]) {
            this._first = view[0];
          }
        }
        this._pulled = false;
      }
    });
    var VirtualList = kendo.Observable.extend({
      init: function(options) {
        var list = this;
        kendo.Observable.fn.init.call(list);
        list.buffer = options.buffer;
        list.height = options.height;
        list.item = options.item;
        list.items = [];
        list.footer = options.footer;
        list.buffer.bind("reset", function() {
          list.refresh();
        });
      },
      refresh: function() {
        var buffer = this.buffer,
            items = this.items,
            endReached = false;
        while (items.length) {
          items.pop().destroy();
        }
        this.offset = buffer.offset;
        var itemConstructor = this.item,
            prevItem,
            item;
        for (var idx = 0; idx < buffer.viewSize; idx++) {
          if (idx === buffer.total()) {
            endReached = true;
            break;
          }
          item = itemConstructor(this.content(this.offset + items.length));
          item.below(prevItem);
          prevItem = item;
          items.push(item);
        }
        this.itemCount = items.length;
        this.trigger("reset");
        this._resize();
        if (endReached) {
          this.trigger("endReached");
        }
      },
      totalHeight: function() {
        if (!this.items[0]) {
          return 0;
        }
        var list = this,
            items = list.items,
            top = items[0].top,
            bottom = items[items.length - 1].bottom,
            averageItemHeight = (bottom - top) / list.itemCount,
            remainingItemsCount = list.buffer.length - list.offset - list.itemCount;
        return (this.footer ? this.footer.height : 0) + bottom + remainingItemsCount * averageItemHeight;
      },
      batchUpdate: function(top) {
        var height = this.height(),
            items = this.items,
            item,
            initialOffset = this.offset;
        if (!items[0]) {
          return ;
        }
        if (this.lastDirection) {
          while (items[items.length - 1].bottom > top + height * 2) {
            if (this.offset === 0) {
              break;
            }
            this.offset--;
            item = items.pop();
            item.update(this.content(this.offset));
            item.above(items[0]);
            items.unshift(item);
          }
        } else {
          while (items[0].top < top - height) {
            var nextIndex = this.offset + this.itemCount;
            if (nextIndex === this.buffer.total()) {
              this.trigger("endReached");
              break;
            }
            if (nextIndex === this.buffer.length) {
              break;
            }
            item = items.shift();
            item.update(this.content(this.offset + this.itemCount));
            item.below(items[items.length - 1]);
            items.push(item);
            this.offset++;
          }
        }
        if (initialOffset !== this.offset) {
          this._resize();
        }
      },
      update: function(top) {
        var list = this,
            items = this.items,
            item,
            firstItem,
            lastItem,
            height = this.height(),
            itemCount = this.itemCount,
            padding = height / 2,
            up = (this.lastTop || 0) > top,
            topBorder = top - padding,
            bottomBorder = top + height + padding;
        if (!items[0]) {
          return ;
        }
        this.lastTop = top;
        this.lastDirection = up;
        if (up) {
          if (items[0].top > topBorder && items[items.length - 1].bottom > bottomBorder + padding && this.offset > 0) {
            this.offset--;
            item = items.pop();
            firstItem = items[0];
            item.update(this.content(this.offset));
            items.unshift(item);
            item.above(firstItem);
            list._resize();
          }
        } else {
          if (items[items.length - 1].bottom < bottomBorder && items[0].top < topBorder - padding) {
            var nextIndex = this.offset + itemCount;
            if (nextIndex === this.buffer.total()) {
              this.trigger("endReached");
            } else if (nextIndex !== this.buffer.length) {
              item = items.shift();
              lastItem = items[items.length - 1];
              items.push(item);
              item.update(this.content(this.offset + this.itemCount));
              list.offset++;
              item.below(lastItem);
              list._resize();
            }
          }
        }
      },
      content: function(index) {
        return this.buffer.at(index);
      },
      destroy: function() {
        this.unbind();
      },
      _resize: function() {
        var items = this.items,
            top = 0,
            bottom = 0,
            firstItem = items[0],
            lastItem = items[items.length - 1];
        if (firstItem) {
          top = firstItem.top;
          bottom = lastItem.bottom;
        }
        this.trigger("resize", {
          top: top,
          bottom: bottom
        });
        if (this.footer) {
          this.footer.below(lastItem);
        }
      }
    });
    kendo.mobile.ui.VirtualList = VirtualList;
    var VirtualListViewItem = kendo.Class.extend({
      init: function(listView, dataItem) {
        var element = listView.append([dataItem], true)[0],
            height = element.offsetHeight;
        $.extend(this, {
          top: 0,
          element: element,
          listView: listView,
          height: height,
          bottom: height
        });
      },
      update: function(dataItem) {
        this.element = this.listView.setDataItem(this.element, dataItem);
      },
      above: function(item) {
        if (item) {
          this.height = this.element.offsetHeight;
          this.top = item.top - this.height;
          this.bottom = item.top;
          putAt(this.element, this.top);
        }
      },
      below: function(item) {
        if (item) {
          this.height = this.element.offsetHeight;
          this.top = item.bottom;
          this.bottom = this.top + this.height;
          putAt(this.element, this.top);
        }
      },
      destroy: function() {
        kendo.destroy(this.element);
        $(this.element).remove();
      }
    });
    var LOAD_ICON = '<div><span class="km-icon"></span><span class="km-loading-left"></span><span class="km-loading-right"></span></div>';
    var VirtualListViewLoadingIndicator = kendo.Class.extend({
      init: function(listView) {
        this.element = $('<li class="km-load-more km-scroller-refresh" style="display: none"></li>').appendTo(listView.element);
        this._loadIcon = $(LOAD_ICON).appendTo(this.element);
      },
      enable: function() {
        this.element.show();
        this.height = this.element.outerHeight(true);
      },
      disable: function() {
        this.element.hide();
        this.height = 0;
      },
      below: function(item) {
        if (item) {
          this.top = item.bottom;
          this.bottom = this.height + this.top;
          putAt(this.element, this.top);
        }
      }
    });
    var VirtualListViewPressToLoadMore = VirtualListViewLoadingIndicator.extend({
      init: function(listView, buffer) {
        this._loadIcon = $(LOAD_ICON).hide();
        this._loadButton = $('<a class="km-load">' + listView.options.messages.loadMoreText + '</a>').hide();
        this.element = $('<li class="km-load-more" style="display: none"></li>').append(this._loadIcon).append(this._loadButton).appendTo(listView.element);
        var loadMore = this;
        this._loadButton.kendoMobileButton().data("kendoMobileButton").bind("click", function() {
          loadMore._hideShowButton();
          buffer.next();
        });
        buffer.bind("resize", function() {
          loadMore._showLoadButton();
        });
        this.height = this.element.outerHeight(true);
        this.disable();
      },
      _hideShowButton: function() {
        this._loadButton.hide();
        this.element.addClass("km-scroller-refresh");
        this._loadIcon.css('display', 'block');
      },
      _showLoadButton: function() {
        this._loadButton.show();
        this.element.removeClass("km-scroller-refresh");
        this._loadIcon.hide();
      }
    });
    var VirtualListViewItemBinder = kendo.Class.extend({
      init: function(listView) {
        var binder = this;
        this.chromeHeight = listView.wrapper.children().not(listView.element).outerHeight() || 0;
        this.listView = listView;
        this.scroller = listView.scroller();
        this.options = listView.options;
        listView.bind("_dataSource", function(e) {
          binder.setDataSource(e.dataSource, e.empty);
        });
        listView.bind("resize", function() {
          if (!binder.list.items.length) {
            return ;
          }
          binder.scroller.reset();
          binder.buffer.range(0);
          binder.list.refresh();
        });
        this.scroller.makeVirtual();
        this.scroller.bind("scroll", function(e) {
          binder.list.update(e.scrollTop);
        });
        this.scroller.bind("scrollEnd", function(e) {
          binder.list.batchUpdate(e.scrollTop);
        });
      },
      destroy: function() {
        this.list.unbind();
        this.buffer.unbind();
      },
      setDataSource: function(dataSource, empty) {
        var binder = this,
            options = this.options,
            listView = this.listView,
            scroller = listView.scroller(),
            pressToLoadMore = options.loadMore,
            pageSize,
            buffer,
            footer;
        this.dataSource = dataSource;
        pageSize = dataSource.pageSize() || options.virtualViewSize;
        if (!pageSize && !empty) {
          throw new Error("the DataSource does not have page size configured. Page Size setting is mandatory for the mobile listview virtual scrolling to work as expected.");
        }
        if (this.buffer) {
          this.buffer.destroy();
        }
        buffer = new kendo.data.Buffer(dataSource, Math.floor(pageSize / 2), pressToLoadMore);
        if (pressToLoadMore) {
          footer = new VirtualListViewPressToLoadMore(listView, buffer);
        } else {
          footer = new VirtualListViewLoadingIndicator(listView);
        }
        if (this.list) {
          this.list.destroy();
        }
        var list = new VirtualList({
          buffer: buffer,
          footer: footer,
          item: function(dataItem) {
            return new VirtualListViewItem(listView, dataItem);
          },
          height: function() {
            return scroller.height();
          }
        });
        list.bind("resize", function() {
          binder.updateScrollerSize();
          listView.updateSize();
        });
        list.bind("reset", function() {
          binder.footer.enable();
        });
        list.bind("endReached", function() {
          footer.disable();
          binder.updateScrollerSize();
        });
        buffer.bind("expand", function() {
          list.lastDirection = false;
          list.batchUpdate(scroller.scrollTop);
        });
        $.extend(this, {
          buffer: buffer,
          scroller: scroller,
          list: list,
          footer: footer
        });
      },
      updateScrollerSize: function() {
        this.scroller.virtualSize(0, this.list.totalHeight() + this.chromeHeight);
      },
      refresh: function() {
        this.list.refresh();
      },
      reset: function() {
        this.buffer.range(0);
        this.list.refresh();
      }
    });
    var ListViewItemBinder = kendo.Class.extend({
      init: function(listView) {
        var binder = this;
        this.listView = listView;
        this.options = listView.options;
        var itemBinder = this;
        this._refreshHandler = function(e) {
          itemBinder.refresh(e);
        };
        this._progressHandler = function() {
          listView.showLoading();
        };
        listView.bind("_dataSource", function(e) {
          binder.setDataSource(e.dataSource);
        });
      },
      destroy: function() {
        this._unbindDataSource();
      },
      reset: function() {},
      refresh: function(e) {
        var action = e && e.action,
            dataItems = e && e.items,
            listView = this.listView,
            dataSource = this.dataSource,
            prependOnRefresh = this.options.appendOnRefresh,
            view = dataSource.view(),
            groups = dataSource.group(),
            groupedMode = groups && groups[0],
            item;
        if (action === "itemchange" && !listView._hasBindingTarget()) {
          item = listView.findByDataItem(dataItems)[0];
          if (item) {
            listView.setDataItem(item, dataItems[0]);
          }
          return ;
        }
        var removedItems,
            addedItems,
            addedDataItems;
        var adding = (action === "add" && !groupedMode) || (prependOnRefresh && !listView._filter);
        var removing = action === "remove" && !groupedMode;
        if (adding) {
          removedItems = [];
        } else if (removing) {
          removedItems = listView.findByDataItem(dataItems);
        }
        if (listView.trigger(DATABINDING, {
          action: action || "rebind",
          items: dataItems,
          removedItems: removedItems,
          index: e && e.index
        })) {
          if (this._shouldShowLoading()) {
            listView.hideLoading();
          }
          return ;
        }
        if (action === "add" && !groupedMode) {
          var index = view.indexOf(dataItems[0]);
          if (index > -1) {
            addedItems = listView.insertAt(dataItems, index);
            addedDataItems = dataItems;
          }
        } else if (action === "remove" && !groupedMode) {
          addedItems = [];
          listView.remove(dataItems);
        } else if (groupedMode) {
          listView.replaceGrouped(view);
        } else if (prependOnRefresh && !listView._filter) {
          addedItems = listView.prepend(view);
          addedDataItems = view;
        } else {
          listView.replace(view);
        }
        if (this._shouldShowLoading()) {
          listView.hideLoading();
        }
        listView.trigger(DATABOUND, {
          ns: ui,
          addedItems: addedItems,
          addedDataItems: addedDataItems
        });
      },
      setDataSource: function(dataSource) {
        if (this.dataSource) {
          this._unbindDataSource();
        }
        this.dataSource = dataSource;
        dataSource.bind(CHANGE, this._refreshHandler);
        if (this._shouldShowLoading()) {
          this.dataSource.bind(PROGRESS, this._progressHandler);
        }
      },
      _unbindDataSource: function() {
        this.dataSource.unbind(CHANGE, this._refreshHandler).unbind(PROGRESS, this._progressHandler);
      },
      _shouldShowLoading: function() {
        var options = this.options;
        return !options.pullToRefresh && !options.loadMore && !options.endlessScroll;
      }
    });
    var ListViewFilter = kendo.Class.extend({
      init: function(listView) {
        var filter = this,
            filterable = listView.options.filterable,
            events = "change paste",
            that = this;
        this.listView = listView;
        this.options = filterable;
        listView.element.before(SEARCH_TEMPLATE({placeholder: filterable.placeholder || "Search..."}));
        if (filterable.autoFilter !== false) {
          events += " keyup";
        }
        this.element = listView.wrapper.find(".km-search-form");
        this.searchInput = listView.wrapper.find("input[type=search]").closest("form").on("submit" + NS, function(e) {
          e.preventDefault();
        }).end().on("focus" + NS, function() {
          filter._oldFilter = filter.searchInput.val();
        }).on(events.split(" ").join(NS + " ") + NS, proxy(this._filterChange, this));
        this.clearButton = listView.wrapper.find(".km-filter-reset").on(CLICK, proxy(this, "_clearFilter")).hide();
        this._dataSourceChange = $.proxy(this._refreshInput, this);
        listView.bind("_dataSource", function(e) {
          e.dataSource.bind("change", that._dataSourceChange);
        });
      },
      _refreshInput: function() {
        var appliedFilters = this.listView.dataSource.filter();
        var searchInput = this.listView._filter.searchInput;
        if (!appliedFilters || appliedFilters.filters[0].field !== this.listView.options.filterable.field) {
          searchInput.val("");
        } else {
          searchInput.val(appliedFilters.filters[0].value);
        }
      },
      _search: function(expr) {
        this._filter = true;
        this.clearButton[expr ? "show" : "hide"]();
        this.listView.dataSource.filter(expr);
      },
      _filterChange: function(e) {
        var filter = this;
        if (e.type == "paste" && this.options.autoFilter !== false) {
          setTimeout(function() {
            filter._applyFilter();
          }, 1);
        } else {
          this._applyFilter();
        }
      },
      _applyFilter: function() {
        var options = this.options,
            value = this.searchInput.val(),
            expr = value.length ? {
              field: options.field,
              operator: options.operator || "startswith",
              ignoreCase: options.ignoreCase,
              value: value
            } : null;
        if (value === this._oldFilter) {
          return ;
        }
        this._oldFilter = value;
        this._search(expr);
      },
      _clearFilter: function(e) {
        this.searchInput.val("");
        this._search(null);
        e.preventDefault();
      }
    });
    var ListView = Widget.extend({
      init: function(element, options) {
        var listView = this;
        Widget.fn.init.call(this, element, options);
        element = this.element;
        options = this.options;
        if (options.scrollTreshold) {
          options.scrollThreshold = options.scrollTreshold;
        }
        element.on("down", HIGHLIGHT_SELECTOR, "_highlight").on("move up cancel", HIGHLIGHT_SELECTOR, "_dim");
        this._userEvents = new kendo.UserEvents(element, {
          filter: ITEM_SELECTOR,
          allowSelection: true,
          tap: function(e) {
            listView._click(e);
          }
        });
        element.css("-ms-touch-action", "auto");
        element.wrap(WRAPPER);
        this.wrapper = this.element.parent();
        this._headerFixer = new HeaderFixer(this);
        this._itemsCache = {};
        this._templates();
        this.virtual = options.endlessScroll || options.loadMore;
        this._style();
        if (this.options.$angular && (this.virtual || this.options.pullToRefresh)) {
          setTimeout($.proxy(this, "_start"));
        } else {
          this._start();
        }
      },
      _start: function() {
        var options = this.options;
        if (this.options.filterable) {
          this._filter = new ListViewFilter(this);
        }
        if (this.virtual) {
          this._itemBinder = new VirtualListViewItemBinder(this);
        } else {
          this._itemBinder = new ListViewItemBinder(this);
        }
        if (this.options.pullToRefresh) {
          this._pullToRefreshHandler = new RefreshHandler(this);
        }
        this.setDataSource(options.dataSource);
        this._enhanceItems(this.items());
        kendo.notify(this, ui);
      },
      events: [CLICK, DATABINDING, DATABOUND, ITEM_CHANGE],
      options: {
        name: "ListView",
        style: "",
        type: "flat",
        autoBind: true,
        fixedHeaders: false,
        template: "#:data#",
        headerTemplate: '<span class="km-text">#:value#</span>',
        appendOnRefresh: false,
        loadMore: false,
        endlessScroll: false,
        scrollThreshold: 30,
        pullToRefresh: false,
        messages: {
          loadMoreText: "Press to load more",
          pullTemplate: "Pull to refresh",
          releaseTemplate: "Release to refresh",
          refreshTemplate: "Refreshing"
        },
        pullOffset: 140,
        filterable: false,
        virtualViewSize: null
      },
      refresh: function() {
        this._itemBinder.refresh();
      },
      reset: function() {
        this._itemBinder.reset();
      },
      setDataSource: function(dataSource) {
        var emptyDataSource = !dataSource;
        this.dataSource = DataSource.create(dataSource);
        this.trigger("_dataSource", {
          dataSource: this.dataSource,
          empty: emptyDataSource
        });
        if (this.options.autoBind && !emptyDataSource) {
          this.items().remove();
          this.dataSource.fetch();
        }
      },
      destroy: function() {
        Widget.fn.destroy.call(this);
        kendo.destroy(this.element);
        this._userEvents.destroy();
        if (this._itemBinder) {
          this._itemBinder.destroy();
        }
        this.element.unwrap();
        delete this.element;
        delete this.wrapper;
        delete this._userEvents;
      },
      items: function() {
        if (this.options.type === "group") {
          return this.element.find(".km-list").children();
        } else {
          return this.element.children().not('.km-load-more');
        }
      },
      scroller: function() {
        if (!this._scrollerInstance) {
          this._scrollerInstance = this.element.closest(".km-scroll-wrapper").data("kendoMobileScroller");
        }
        return this._scrollerInstance;
      },
      showLoading: function() {
        var view = this.view();
        if (view && view.loader) {
          view.loader.show();
        }
      },
      hideLoading: function() {
        var view = this.view();
        if (view && view.loader) {
          view.loader.hide();
        }
      },
      insertAt: function(dataItems, index, triggerChange) {
        var listView = this;
        return listView._renderItems(dataItems, function(items) {
          if (index === 0) {
            listView.element.prepend(items);
          } else if (index === -1) {
            listView.element.append(items);
          } else {
            listView.items().eq(index - 1).after(items);
          }
          if (triggerChange) {
            for (var i = 0; i < items.length; i++) {
              listView.trigger(ITEM_CHANGE, {
                item: items.eq(i),
                data: dataItems[i],
                ns: ui
              });
            }
          }
        });
      },
      append: function(dataItems, triggerChange) {
        return this.insertAt(dataItems, -1, triggerChange);
      },
      prepend: function(dataItems, triggerChange) {
        return this.insertAt(dataItems, 0, triggerChange);
      },
      replace: function(dataItems) {
        this.options.type = "flat";
        this._angularItems("cleanup");
        this.element.empty();
        this._style();
        return this.insertAt(dataItems, 0);
      },
      replaceGrouped: function(groups) {
        this.options.type = "group";
        this._angularItems("cleanup");
        this.element.empty();
        var items = $(kendo.render(this.groupTemplate, groups));
        this._enhanceItems(items.children("ul").children("li"));
        this.element.append(items);
        mobile.init(items);
        this._style();
        this._angularItems("compile");
      },
      remove: function(dataItems) {
        var items = this.findByDataItem(dataItems);
        this.angular("cleanup", function() {
          return {elements: items};
        });
        kendo.destroy(items);
        items.remove();
      },
      findByDataItem: function(dataItems) {
        var selectors = [];
        for (var idx = 0,
            length = dataItems.length; idx < length; idx++) {
          selectors[idx] = "[data-" + kendo.ns + "uid=" + dataItems[idx].uid + "]";
        }
        return this.element.find(selectors.join(","));
      },
      setDataItem: function(item, dataItem) {
        var listView = this,
            replaceItem = function(items) {
              var newItem = $(items[0]);
              kendo.destroy(item);
              $(item).replaceWith(newItem);
              listView.trigger(ITEM_CHANGE, {
                item: newItem,
                data: dataItem,
                ns: ui
              });
            };
        return this._renderItems([dataItem], replaceItem)[0];
      },
      updateSize: function() {
        this._size = this.getSize();
      },
      _renderItems: function(dataItems, callback) {
        var items = $(kendo.render(this.template, dataItems));
        this.angular("compile", function() {
          return {
            elements: items,
            data: dataItems.map(function(data) {
              return {dataItem: data};
            })
          };
        });
        callback(items);
        mobile.init(items);
        this._enhanceItems(items);
        return items;
      },
      _dim: function(e) {
        this._toggle(e, false);
      },
      _highlight: function(e) {
        this._toggle(e, true);
      },
      _toggle: function(e, highlight) {
        if (e.which > 1) {
          return ;
        }
        var clicked = $(e.currentTarget),
            item = clicked.parent(),
            role = attrValue(clicked, "role") || "",
            plainItem = (!role.match(buttonRegExp)),
            prevented = e.isDefaultPrevented();
        if (plainItem) {
          item.toggleClass(ACTIVE_CLASS, highlight && !prevented);
        }
      },
      _templates: function() {
        var template = this.options.template,
            headerTemplate = this.options.headerTemplate,
            dataIDAttribute = ' data-uid="#=arguments[0].uid || ""#"',
            templateProxy = {},
            groupTemplateProxy = {};
        if (typeof template === FUNCTION) {
          templateProxy.template = template;
          template = "#=this.template(data)#";
        }
        this.template = proxy(kendo.template("<li" + dataIDAttribute + ">" + template + "</li>"), templateProxy);
        groupTemplateProxy.template = this.template;
        if (typeof headerTemplate === FUNCTION) {
          groupTemplateProxy._headerTemplate = headerTemplate;
          headerTemplate = "#=this._headerTemplate(data)#";
        }
        groupTemplateProxy.headerTemplate = kendo.template(headerTemplate);
        this.groupTemplate = proxy(GROUP_TEMPLATE, groupTemplateProxy);
      },
      _click: function(e) {
        if (e.event.which > 1 || e.event.isDefaultPrevented()) {
          return ;
        }
        var dataItem,
            item = e.target,
            target = $(e.event.target),
            buttonElement = target.closest(kendo.roleSelector("button", "detailbutton", "backbutton")),
            button = kendo.widgetInstance(buttonElement, ui),
            id = item.attr(kendo.attr("uid"));
        if (id) {
          dataItem = this.dataSource.getByUid(id);
        }
        if (this.trigger(CLICK, {
          target: target,
          item: item,
          dataItem: dataItem,
          button: button
        })) {
          e.preventDefault();
        }
      },
      _styleGroups: function() {
        var rootItems = this.element.children();
        rootItems.children("ul").addClass("km-list");
        rootItems.each(function() {
          var li = $(this),
              groupHeader = li.contents().first();
          li.addClass("km-group-container");
          if (!groupHeader.is("ul") && !groupHeader.is("div." + GROUP_CLASS)) {
            groupHeader.wrap(GROUP_WRAPPER);
          }
        });
      },
      _style: function() {
        var options = this.options,
            grouped = options.type === "group",
            element = this.element,
            inset = options.style === "inset";
        element.addClass("km-listview").toggleClass("km-list", !grouped).toggleClass("km-virtual-list", this.virtual).toggleClass("km-listinset", !grouped && inset).toggleClass("km-listgroup", grouped && !inset).toggleClass("km-listgroupinset", grouped && inset);
        if (!element.parents(".km-listview")[0]) {
          element.closest(".km-content").toggleClass("km-insetcontent", inset);
        }
        if (grouped) {
          this._styleGroups();
        }
        this.trigger(STYLED);
      },
      _enhanceItems: function(items) {
        items.each(function() {
          var item = $(this),
              child,
              enhanced = false;
          item.children().each(function() {
            child = $(this);
            if (child.is("a")) {
              enhanceLinkItem(child);
              enhanced = true;
            } else if (child.is("label")) {
              enhanceCheckBoxItem(child);
              enhanced = true;
            }
          });
          if (!enhanced) {
            enhanceItem(item);
          }
        });
      }
    });
    ui.plugin(ListView);
  })(window.kendo.jQuery);
  return window.kendo;
}, typeof define == 'function' && define.amd ? define : function(_, f) {
  f();
});
})();
(function() {
function define(){};  define.amd = {};
(function(f, define) {
  define(["./kendo.userevents"], f);
})(function() {
  (function($, undefined) {
    var kendo = window.kendo,
        mobile = kendo.mobile,
        ui = mobile.ui,
        Widget = ui.Widget,
        support = kendo.support,
        os = support.mobileOS,
        ANDROID3UP = os.android && os.flatVersion >= 300,
        CLICK = "click",
        DISABLED = "disabled",
        DISABLEDSTATE = "km-state-disabled";
    function highlightButton(widget, event, highlight) {
      $(event.target).closest(".km-button,.km-detail").toggleClass("km-state-active", highlight);
      if (ANDROID3UP && widget.deactivateTimeoutID) {
        clearTimeout(widget.deactivateTimeoutID);
        widget.deactivateTimeoutID = 0;
      }
    }
    function createBadge(value) {
      return $('<span class="km-badge">' + value + '</span>');
    }
    var Button = Widget.extend({
      init: function(element, options) {
        var that = this;
        Widget.fn.init.call(that, element, options);
        var useTap = that.options.clickOn === "up";
        that._wrap();
        that._style();
        if (!useTap) {
          that.element.attr("data-navigate-on-press", true);
        }
        that.options.enable = that.options.enable && !that.element.attr(DISABLED);
        that.enable(that.options.enable);
        that._userEvents = new kendo.UserEvents(that.element, {
          allowSelection: !useTap,
          press: function(e) {
            that._activate(e);
          },
          release: function(e) {
            highlightButton(that, e, false);
            if (!useTap) {
              e.event.stopPropagation();
            }
          }
        });
        that._userEvents.bind(useTap ? "tap" : "press", function(e) {
          that._release(e);
        });
        if (ANDROID3UP) {
          that.element.on("move", function(e) {
            that._timeoutDeactivate(e);
          });
        }
      },
      destroy: function() {
        Widget.fn.destroy.call(this);
        this._userEvents.destroy();
      },
      events: [CLICK],
      options: {
        name: "Button",
        icon: "",
        style: "",
        badge: "",
        clickOn: "up",
        enable: true
      },
      badge: function(value) {
        var badge = this.badgeElement = this.badgeElement || createBadge(value).appendTo(this.element);
        if (value || value === 0) {
          badge.html(value);
          return this;
        }
        if (value === false) {
          badge.empty().remove();
          this.badgeElement = false;
          return this;
        }
        return badge.html();
      },
      enable: function(enable) {
        var element = this.element;
        if (typeof enable == "undefined") {
          enable = true;
        }
        this.options.enable = enable;
        if (enable) {
          element.removeAttr(DISABLED);
        } else {
          element.attr(DISABLED, DISABLED);
        }
        element.toggleClass(DISABLEDSTATE, !enable);
      },
      _timeoutDeactivate: function(e) {
        if (!this.deactivateTimeoutID) {
          this.deactivateTimeoutID = setTimeout(highlightButton, 500, this, e, false);
        }
      },
      _activate: function(e) {
        var activeElement = document.activeElement,
            nodeName = activeElement ? activeElement.nodeName : "";
        if (this.options.enable) {
          highlightButton(this, e, true);
          if (nodeName == "INPUT" || nodeName == "TEXTAREA") {
            activeElement.blur();
          }
        }
      },
      _release: function(e) {
        var that = this;
        if (e.which > 1) {
          return ;
        }
        if (!that.options.enable) {
          e.preventDefault();
          return ;
        }
        if (that.trigger(CLICK, {
          target: $(e.target),
          button: that.element
        })) {
          e.preventDefault();
        }
      },
      _style: function() {
        var style = this.options.style,
            element = this.element,
            styles;
        if (style) {
          styles = style.split(" ");
          $.each(styles, function() {
            element.addClass("km-" + this);
          });
        }
      },
      _wrap: function() {
        var that = this,
            icon = that.options.icon,
            badge = that.options.badge,
            iconSpan = '<span class="km-icon km-' + icon,
            element = that.element.addClass("km-button"),
            span = element.children("span:not(.km-icon)").addClass("km-text"),
            image = element.find("img").addClass("km-image");
        if (!span[0] && element.html()) {
          span = element.wrapInner('<span class="km-text" />').children("span.km-text");
        }
        if (!image[0] && icon) {
          if (!span[0]) {
            iconSpan += " km-notext";
          }
          that.iconElement = element.prepend($(iconSpan + '" />'));
        }
        if (badge || badge === 0) {
          that.badgeElement = createBadge(badge).appendTo(element);
        }
      }
    });
    var BackButton = Button.extend({
      options: {
        name: "BackButton",
        style: "back"
      },
      init: function(element, options) {
        var that = this;
        Button.fn.init.call(that, element, options);
        if (typeof that.element.attr("href") === "undefined") {
          that.element.attr("href", "#:back");
        }
      }
    });
    var DetailButton = Button.extend({
      options: {
        name: "DetailButton",
        style: ""
      },
      init: function(element, options) {
        Button.fn.init.call(this, element, options);
      },
      _style: function() {
        var style = this.options.style + " detail",
            element = this.element;
        if (style) {
          var styles = style.split(" ");
          $.each(styles, function() {
            element.addClass("km-" + this);
          });
        }
      },
      _wrap: function() {
        var that = this,
            icon = that.options.icon,
            iconSpan = '<span class="km-icon km-' + icon,
            element = that.element,
            span = element.children("span"),
            image = element.find("img").addClass("km-image");
        if (!image[0] && icon) {
          if (!span[0]) {
            iconSpan += " km-notext";
          }
          element.prepend($(iconSpan + '" />'));
        }
      }
    });
    ui.plugin(Button);
    ui.plugin(BackButton);
    ui.plugin(DetailButton);
  })(window.kendo.jQuery);
  return window.kendo;
}, typeof define == 'function' && define.amd ? define : function(_, f) {
  f();
});
})();
(function() {
function define(){};  define.amd = {};
(function(f, define) {
  define(["./kendo.core"], f);
})(function() {
  (function($, undefined) {
    var kendo = window.kendo,
        mobile = kendo.mobile,
        ui = mobile.ui,
        Widget = ui.Widget;
    function createContainer(align, element) {
      var items = element.find("[" + kendo.attr("align") + "=" + align + "]");
      if (items[0]) {
        return $('<div class="km-' + align + 'item" />').append(items).prependTo(element);
      }
    }
    function toggleTitle(centerElement) {
      var siblings = centerElement.siblings(),
          noTitle = !!centerElement.children("ul")[0],
          showTitle = (!!siblings[0] && $.trim(centerElement.text()) === ""),
          android = !!(kendo.mobile.application && kendo.mobile.application.element.is(".km-android"));
      centerElement.prevAll().toggleClass("km-absolute", noTitle);
      centerElement.toggleClass("km-show-title", showTitle);
      centerElement.toggleClass("km-fill-title", showTitle && !$.trim(centerElement.html()));
      centerElement.toggleClass("km-no-title", noTitle);
      centerElement.toggleClass("km-hide-title", android && !siblings.children().is(":visible"));
    }
    var NavBar = Widget.extend({
      init: function(element, options) {
        var that = this;
        Widget.fn.init.call(that, element, options);
        element = that.element;
        that.container().bind("show", $.proxy(this, "refresh"));
        element.addClass("km-navbar").wrapInner($('<div class="km-view-title km-show-title" />'));
        that.leftElement = createContainer("left", element);
        that.rightElement = createContainer("right", element);
        that.centerElement = element.find(".km-view-title");
      },
      options: {name: "NavBar"},
      title: function(value) {
        this.element.find(kendo.roleSelector("view-title")).text(value);
        toggleTitle(this.centerElement);
      },
      refresh: function(e) {
        var view = e.view;
        if (view.options.title) {
          this.title(view.options.title);
        } else {
          toggleTitle(this.centerElement);
        }
      },
      destroy: function() {
        Widget.fn.destroy.call(this);
        kendo.destroy(this.element);
      }
    });
    ui.plugin(NavBar);
  })(window.kendo.jQuery);
  return window.kendo;
}, typeof define == 'function' && define.amd ? define : function(_, f) {
  f();
});
})();
(function() {
function define(){};  define.amd = {};
(function(f, define) {
  define(["./kendo.core", "./kendo.userevents"], f);
})(function() {
  (function($, undefined) {
    var kendo = window.kendo,
        Widget = kendo.ui.Widget,
        proxy = $.proxy,
        abs = Math.abs,
        MAX_DOUBLE_TAP_DISTANCE = 20;
    var Touch = Widget.extend({
      init: function(element, options) {
        var that = this;
        Widget.fn.init.call(that, element, options);
        options = that.options;
        element = that.element;
        that.wrapper = element;
        function eventProxy(name) {
          return function(e) {
            that._triggerTouch(name, e);
          };
        }
        function gestureEventProxy(name) {
          return function(e) {
            that.trigger(name, {
              touches: e.touches,
              distance: e.distance,
              center: e.center,
              event: e.event
            });
          };
        }
        that.events = new kendo.UserEvents(element, {
          filter: options.filter,
          surface: options.surface,
          minHold: options.minHold,
          multiTouch: options.multiTouch,
          allowSelection: true,
          press: eventProxy("touchstart"),
          hold: eventProxy("hold"),
          tap: proxy(that, "_tap"),
          gesturestart: gestureEventProxy("gesturestart"),
          gesturechange: gestureEventProxy("gesturechange"),
          gestureend: gestureEventProxy("gestureend")
        });
        if (options.enableSwipe) {
          that.events.bind("start", proxy(that, "_swipestart"));
          that.events.bind("move", proxy(that, "_swipemove"));
        } else {
          that.events.bind("start", proxy(that, "_dragstart"));
          that.events.bind("move", eventProxy("drag"));
          that.events.bind("end", eventProxy("dragend"));
        }
        kendo.notify(that);
      },
      events: ["touchstart", "dragstart", "drag", "dragend", "tap", "doubletap", "hold", "swipe", "gesturestart", "gesturechange", "gestureend"],
      options: {
        name: "Touch",
        surface: null,
        global: false,
        multiTouch: false,
        enableSwipe: false,
        minXDelta: 30,
        maxYDelta: 20,
        maxDuration: 1000,
        minHold: 800,
        doubleTapTimeout: 800
      },
      cancel: function() {
        this.events.cancel();
      },
      _triggerTouch: function(type, e) {
        if (this.trigger(type, {
          touch: e.touch,
          event: e.event
        })) {
          e.preventDefault();
        }
      },
      _tap: function(e) {
        var that = this,
            lastTap = that.lastTap,
            touch = e.touch;
        if (lastTap && (touch.endTime - lastTap.endTime < that.options.doubleTapTimeout) && kendo.touchDelta(touch, lastTap).distance < MAX_DOUBLE_TAP_DISTANCE) {
          that._triggerTouch("doubletap", e);
          that.lastTap = null;
        } else {
          that._triggerTouch("tap", e);
          that.lastTap = touch;
        }
      },
      _dragstart: function(e) {
        this._triggerTouch("dragstart", e);
      },
      _swipestart: function(e) {
        if (abs(e.x.velocity) * 2 >= abs(e.y.velocity)) {
          e.sender.capture();
        }
      },
      _swipemove: function(e) {
        var that = this,
            options = that.options,
            touch = e.touch,
            duration = e.event.timeStamp - touch.startTime,
            direction = touch.x.initialDelta > 0 ? "right" : "left";
        if (abs(touch.x.initialDelta) >= options.minXDelta && abs(touch.y.initialDelta) < options.maxYDelta && duration < options.maxDuration) {
          that.trigger("swipe", {
            direction: direction,
            touch: e.touch
          });
          touch.cancel();
        }
      }
    });
    kendo.ui.plugin(Touch);
  })(window.kendo.jQuery);
  return window.kendo;
}, typeof define == 'function' && define.amd ? define : function(_, f) {
  f();
});
})();
System.register("github:burkeholland/kendo-flippable@master/kendo.flippable.min", [], false, function(__require, __exports, __module) {
  System.get("@@global-helpers").prepareGlobal(__module.id, []);
  (function() {
    !function(a, b) {
      b(["./kendo.core", "./kendo.fx"], a);
    }(function() {
      return function(a) {
        var b = window.kendo,
            c = b.ui,
            d = c.Widget,
            e = "click",
            f = "flipStart",
            g = "flipEnd",
            h = ".kendoFlip",
            i = a.proxy,
            j = d.extend({
              init: function(a, b) {
                var c = this;
                d.fn.init.call(this, a, b), a = c.element, c.panes = a.children(), c._wrapper(), c._panes(), c._effect(), a.on(e + h, i(c._click, c)), a.on(f + h, i(c._flipStart, c)), a.on(g + h, i(c._flipEnd, c)), c._show();
              },
              options: {
                height: 0,
                width: 0,
                name: "Flippable",
                duration: 800
              },
              events: [e, f, g],
              flipVertical: function() {
                this._flip(this.flipV);
              },
              flipHorizontal: function() {
                this._flip(this.flipH);
              },
              _flip: function(a) {
                var b = this.reverse;
                a.stop(), this._flipStart(this), b ? a.reverse().then(this._flipEnd(this)) : a.play().then(this._flipEnd(this)), this.reverse = !b;
              },
              _flipStart: function(a) {
                this.trigger(f, {event: a});
              },
              _flipEnd: function(a) {
                this.trigger(g, {event: a});
              },
              _wrapper: function() {
                var a = this.element,
                    b = this.panes,
                    c = a.height(),
                    d = b.first().height();
                height = this.options.height || (c > d ? c : d), a.css({
                  position: "relative",
                  height: height,
                  width: this.options.width || "auto"
                });
              },
              _panes: function() {
                var b = this.panes;
                b.addClass("k-header"), b.each(function() {
                  var b = a(this);
                  b.css({
                    position: "absolute",
                    width: "100%",
                    height: "100%"
                  });
                });
              },
              _effect: function() {
                var a = this,
                    c = a.element,
                    d = a.panes,
                    e = d.first(),
                    f = d.next();
                a.flipH = b.fx(c).flipHorizontal(e, f).duration(a.options.duration), a.flipV = b.fx(c).flipVertical(e, f).duration(a.options.duration), f.hide(), a.reverse = !1;
              },
              _show: function() {
                {
                  var a = this.element;
                  this.panes;
                }
                a.show();
              },
              _click: function(a) {
                this.trigger(e, {event: a});
              }
            });
        c.plugin(j);
      }(window.kendo.jQuery), window.kendo;
    }, "function" == typeof define && define.amd ? define : function(a, b) {
      b();
    });
  }).call(System.global);
  return System.get("@@global-helpers").retrieveGlobal(__module.id, false);
});

System.register("npm:core-js@0.9.18/library/modules/$.fw", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function($) {
    $.FW = false;
    $.path = $.core;
    return $;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.def", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      global = $.g,
      core = $.core,
      isFunction = $.isFunction;
  function ctx(fn, that) {
    return function() {
      return fn.apply(that, arguments);
    };
  }
  $def.F = 1;
  $def.G = 2;
  $def.S = 4;
  $def.P = 8;
  $def.B = 16;
  $def.W = 32;
  function $def(type, name, source) {
    var key,
        own,
        out,
        exp,
        isGlobal = type & $def.G,
        isProto = type & $def.P,
        target = isGlobal ? global : type & $def.S ? global[name] : (global[name] || {}).prototype,
        exports = isGlobal ? core : core[name] || (core[name] = {});
    if (isGlobal)
      source = name;
    for (key in source) {
      own = !(type & $def.F) && target && key in target;
      if (own && key in exports)
        continue;
      out = own ? target[key] : source[key];
      if (isGlobal && !isFunction(target[key]))
        exp = source[key];
      else if (type & $def.B && own)
        exp = ctx(out, global);
      else if (type & $def.W && target[key] == out)
        !function(C) {
          exp = function(param) {
            return this instanceof C ? new C(param) : C(param);
          };
          exp.prototype = C.prototype;
        }(out);
      else
        exp = isProto && isFunction(out) ? ctx(Function.call, out) : out;
      exports[key] = exp;
      if (isProto)
        (exports.prototype || (exports.prototype = {}))[key] = out;
    }
  }
  module.exports = $def;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.get-names", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      toString = {}.toString,
      getNames = $.getNames;
  var windowNames = typeof window == 'object' && Object.getOwnPropertyNames ? Object.getOwnPropertyNames(window) : [];
  function getWindowNames(it) {
    try {
      return getNames(it);
    } catch (e) {
      return windowNames.slice();
    }
  }
  module.exports.get = function getOwnPropertyNames(it) {
    if (windowNames && toString.call(it) == '[object Window]')
      return getWindowNames(it);
    return getNames($.toObject(it));
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/object/create", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  module.exports = function create(P, D) {
    return $.create(P, D);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.3/helpers/class-call-check", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = function(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/object/define-property", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  module.exports = function defineProperty(it, key, desc) {
    return $.setDesc(it, key, desc);
  };
  global.define = __define;
  return module.exports;
});

(function() {
function define(){};  define.amd = {};
System.register("github:components/jquery@2.1.4", ["github:components/jquery@2.1.4/jquery"], false, function(__require, __exports, __module) {
  return (function(main) {
    return main;
  }).call(this, __require('github:components/jquery@2.1.4/jquery'));
});
})();
System.register("github:burkeholland/kendo-flippable@master", ["github:burkeholland/kendo-flippable@master/kendo.flippable.min"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:burkeholland/kendo-flippable@master/kendo.flippable.min");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$", ["npm:core-js@0.9.18/library/modules/$.fw"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var global = typeof self != 'undefined' ? self : Function('return this')(),
      core = {},
      defineProperty = Object.defineProperty,
      hasOwnProperty = {}.hasOwnProperty,
      ceil = Math.ceil,
      floor = Math.floor,
      max = Math.max,
      min = Math.min;
  var DESC = !!function() {
    try {
      return defineProperty({}, 'a', {get: function() {
          return 2;
        }}).a == 2;
    } catch (e) {}
  }();
  var hide = createDefiner(1);
  function toInteger(it) {
    return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
  }
  function desc(bitmap, value) {
    return {
      enumerable: !(bitmap & 1),
      configurable: !(bitmap & 2),
      writable: !(bitmap & 4),
      value: value
    };
  }
  function simpleSet(object, key, value) {
    object[key] = value;
    return object;
  }
  function createDefiner(bitmap) {
    return DESC ? function(object, key, value) {
      return $.setDesc(object, key, desc(bitmap, value));
    } : simpleSet;
  }
  function isObject(it) {
    return it !== null && (typeof it == 'object' || typeof it == 'function');
  }
  function isFunction(it) {
    return typeof it == 'function';
  }
  function assertDefined(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  }
  var $ = module.exports = require("npm:core-js@0.9.18/library/modules/$.fw")({
    g: global,
    core: core,
    html: global.document && document.documentElement,
    isObject: isObject,
    isFunction: isFunction,
    that: function() {
      return this;
    },
    toInteger: toInteger,
    toLength: function(it) {
      return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
    },
    toIndex: function(index, length) {
      index = toInteger(index);
      return index < 0 ? max(index + length, 0) : min(index, length);
    },
    has: function(it, key) {
      return hasOwnProperty.call(it, key);
    },
    create: Object.create,
    getProto: Object.getPrototypeOf,
    DESC: DESC,
    desc: desc,
    getDesc: Object.getOwnPropertyDescriptor,
    setDesc: defineProperty,
    setDescs: Object.defineProperties,
    getKeys: Object.keys,
    getNames: Object.getOwnPropertyNames,
    getSymbols: Object.getOwnPropertySymbols,
    assertDefined: assertDefined,
    ES5Object: Object,
    toObject: function(it) {
      return $.ES5Object(assertDefined(it));
    },
    hide: hide,
    def: createDefiner(0),
    set: global.Symbol ? simpleSet : hide,
    each: [].forEach
  });
  if (typeof __e != 'undefined')
    __e = core;
  if (typeof __g != 'undefined')
    __g = global;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.object.statics-accept-primitives", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.def", "npm:core-js@0.9.18/library/modules/$.get-names"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      $def = require("npm:core-js@0.9.18/library/modules/$.def"),
      isObject = $.isObject,
      toObject = $.toObject;
  $.each.call(('freeze,seal,preventExtensions,isFrozen,isSealed,isExtensible,' + 'getOwnPropertyDescriptor,getPrototypeOf,keys,getOwnPropertyNames').split(','), function(KEY, ID) {
    var fn = ($.core.Object || {})[KEY] || Object[KEY],
        forced = 0,
        method = {};
    method[KEY] = ID == 0 ? function freeze(it) {
      return isObject(it) ? fn(it) : it;
    } : ID == 1 ? function seal(it) {
      return isObject(it) ? fn(it) : it;
    } : ID == 2 ? function preventExtensions(it) {
      return isObject(it) ? fn(it) : it;
    } : ID == 3 ? function isFrozen(it) {
      return isObject(it) ? fn(it) : true;
    } : ID == 4 ? function isSealed(it) {
      return isObject(it) ? fn(it) : true;
    } : ID == 5 ? function isExtensible(it) {
      return isObject(it) ? fn(it) : false;
    } : ID == 6 ? function getOwnPropertyDescriptor(it, key) {
      return fn(toObject(it), key);
    } : ID == 7 ? function getPrototypeOf(it) {
      return fn(Object($.assertDefined(it)));
    } : ID == 8 ? function keys(it) {
      return fn(toObject(it));
    } : require("npm:core-js@0.9.18/library/modules/$.get-names").get;
    try {
      fn('z');
    } catch (e) {
      forced = 1;
    }
    $def($def.S + $def.F * forced, 'Object', method);
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.3/core-js/object/create", ["npm:core-js@0.9.18/library/fn/object/create"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/object/create"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.3/core-js/object/define-property", ["npm:core-js@0.9.18/library/fn/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/object/define-property"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/object/get-own-property-descriptor", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/es6.object.statics-accept-primitives"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  require("npm:core-js@0.9.18/library/modules/es6.object.statics-accept-primitives");
  module.exports = function getOwnPropertyDescriptor(it, key) {
    return $.getDesc(it, key);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.3/helpers/inherits", ["npm:babel-runtime@5.8.3/core-js/object/create"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$create = require("npm:babel-runtime@5.8.3/core-js/object/create")["default"];
  exports["default"] = function(subClass, superClass) {
    if (typeof superClass !== "function" && superClass !== null) {
      throw new TypeError("Super expression must either be null or a function, not " + typeof superClass);
    }
    subClass.prototype = _Object$create(superClass && superClass.prototype, {constructor: {
        value: subClass,
        enumerable: false,
        writable: true,
        configurable: true
      }});
    if (superClass)
      subClass.__proto__ = superClass;
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.3/helpers/create-class", ["npm:babel-runtime@5.8.3/core-js/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("npm:babel-runtime@5.8.3/core-js/object/define-property")["default"];
  exports["default"] = (function() {
    function defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor)
          descriptor.writable = true;
        _Object$defineProperty(target, descriptor.key, descriptor);
      }
    }
    return function(Constructor, protoProps, staticProps) {
      if (protoProps)
        defineProperties(Constructor.prototype, protoProps);
      if (staticProps)
        defineProperties(Constructor, staticProps);
      return Constructor;
    };
  })();
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.3/core-js/object/get-own-property-descriptor", ["npm:core-js@0.9.18/library/fn/object/get-own-property-descriptor"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/object/get-own-property-descriptor"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.3/helpers/get", ["npm:babel-runtime@5.8.3/core-js/object/get-own-property-descriptor"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$getOwnPropertyDescriptor = require("npm:babel-runtime@5.8.3/core-js/object/get-own-property-descriptor")["default"];
  exports["default"] = function get(_x, _x2, _x3) {
    var _again = true;
    _function: while (_again) {
      var object = _x,
          property = _x2,
          receiver = _x3;
      desc = parent = getter = undefined;
      _again = false;
      if (object === null)
        object = Function.prototype;
      var desc = _Object$getOwnPropertyDescriptor(object, property);
      if (desc === undefined) {
        var parent = Object.getPrototypeOf(object);
        if (parent === null) {
          return undefined;
        } else {
          _x = parent;
          _x2 = property;
          _x3 = receiver;
          _again = true;
          continue _function;
        }
      } else if ("value" in desc) {
        return desc.value;
      } else {
        var getter = desc.get;
        if (getter === undefined) {
          return undefined;
        }
        return getter.call(receiver);
      }
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register('src/dataSources/search-history-dataSource', [], function (_export) {
	'use strict';

	var searchHistoryDataSource;
	return {
		setters: [],
		execute: function () {
			searchHistoryDataSource = new kendo.data.DataSource({
				offlineStorage: 'search-history',
				schema: {
					model: {
						id: 'artistId'
					},
					parse: function parse(data) {
						return data.reverse();
					}
				}
			});

			_export('default', searchHistoryDataSource);
		}
	};
});
System.register('src/itunes-api', [], function (_export) {
	'use strict';

	var API;
	return {
		setters: [],
		execute: function () {
			API = {
				SEARCH: 'https://itunes.apple.com/search?',
				LOOKUP: 'https://itunes.apple.com/lookup?'
			};

			_export('default', API);
		}
	};
});
System.register('src/dataSources/albums-dataSource', ['src/components/component', 'src/itunes-api'], function (_export) {
	'use strict';

	var Component, itunes, albumsDataSource;
	return {
		setters: [function (_srcComponentsComponent) {
			Component = _srcComponentsComponent['default'];
		}, function (_srcItunesApi) {
			itunes = _srcItunesApi['default'];
		}],
		execute: function () {
			albumsDataSource = new kendo.data.DataSource({
				transport: {
					read: {
						url: itunes.LOOKUP,
						dataType: 'jsonp',
						data: function data(args) {
							return {
								entity: 'album',
								id: args.id
							};
						}
					}
				},
				schema: {
					data: "results",
					parse: function parse(data) {
						$.each(data.results, function () {
							// add a place holder on the albums ds for tracks which is not
							// included in the original response

							this.tracks = new kendo.data.ObservableArray([]);

							// set the artist name
							Component.trigger('artist/update', data.results[0].artistName);
						});

						kendo.ui.progress($('#main'), false);

						return data;
					},
					model: {
						id: "collectionId",
						fields: {
							releaseDate: {
								type: "date"
							}
						}
					}
				},
				filter: { field: "wrapperType", operator: "equals", value: "collection" }
			});

			_export('default', albumsDataSource);
		}
	};
});
System.register('src/dataSources/tracks-dataSource', ['src/itunes-api'], function (_export) {
  'use strict';

  var itunes, tracksDataSource;
  return {
    setters: [function (_srcItunesApi) {
      itunes = _srcItunesApi['default'];
    }],
    execute: function () {
      tracksDataSource = new kendo.data.DataSource({
        transport: {
          read: {
            url: itunes.LOOKUP,
            dataType: 'jsonp',
            data: function data(args) {
              return {
                entity: 'song',
                id: args.id
              };
            }
          }
        },
        schema: {
          data: 'results',
          parse: function parse(data) {
            // add a default 'isPlaying' flag which will be used later to determine
            // the state of a particular track in the UI
            $.each(data.results, function () {
              this.isPlaying = false;
            });
            return data;
          },
          model: {
            id: 'collectionId',
            fields: {
              releaseDate: {
                type: 'date'
              }
            }
          }
        },
        filter: { field: 'wrapperType', operator: 'equals', value: 'track' }
      });

      _export('default', tracksDataSource);
    }
  };
});
System.register('src/components/player', ['npm:babel-runtime@5.8.3/helpers/get', 'npm:babel-runtime@5.8.3/helpers/inherits', 'npm:babel-runtime@5.8.3/helpers/class-call-check', 'src/components/component'], function (_export) {
	var _get, _inherits, _classCallCheck, Component, player, template, Player;

	return {
		setters: [function (_npmBabelRuntime583HelpersGet) {
			_get = _npmBabelRuntime583HelpersGet['default'];
		}, function (_npmBabelRuntime583HelpersInherits) {
			_inherits = _npmBabelRuntime583HelpersInherits['default'];
		}, function (_npmBabelRuntime583HelpersClassCallCheck) {
			_classCallCheck = _npmBabelRuntime583HelpersClassCallCheck['default'];
		}, function (_srcComponentsComponent) {
			Component = _srcComponentsComponent['default'];
		}],
		execute: function () {
			'use strict';

			player = undefined;
			template = '<audio id="player" style="display: none"></audio>';

			Player = (function (_Component) {
				_inherits(Player, _Component);

				function Player(container) {
					_classCallCheck(this, Player);

					_get(Object.getPrototypeOf(Player.prototype), 'constructor', this).call(this, container, template);

					Component.on('player/play', function (e, args) {
						player.src = args.previewUrl;
						player.play();
					});

					Component.on('player/pause', function () {
						player.pause();
					});

					Component.on('player/stop', function () {
						player.pause();
						player.currentTime = 0;
					});

					player = $('#player')[0];
				}

				return Player;
			})(Component);

			_export('default', Player);
		}
	};
});
System.register('src/kendo', ['github:kendo-labs/bower-kendo-ui@2015.2.727/src/js/kendo.core', 'github:kendo-labs/bower-kendo-ui@2015.2.727/src/js/kendo.data', 'github:kendo-labs/bower-kendo-ui@2015.2.727/src/js/kendo.binder', 'github:kendo-labs/bower-kendo-ui@2015.2.727/src/js/kendo.fx', 'github:kendo-labs/bower-kendo-ui@2015.2.727/src/js/kendo.responsivepanel', 'github:kendo-labs/bower-kendo-ui@2015.2.727/src/js/kendo.autocomplete', 'github:kendo-labs/bower-kendo-ui@2015.2.727/src/js/kendo.mobile.listview', 'github:kendo-labs/bower-kendo-ui@2015.2.727/src/js/kendo.mobile.button', 'github:kendo-labs/bower-kendo-ui@2015.2.727/src/js/kendo.mobile.navbar', 'github:kendo-labs/bower-kendo-ui@2015.2.727/src/js/kendo.touch'], function (_export) {
  'use strict';

  return {
    setters: [function (_githubKendoLabsBowerKendoUi20152727SrcJsKendoCore) {}, function (_githubKendoLabsBowerKendoUi20152727SrcJsKendoData) {}, function (_githubKendoLabsBowerKendoUi20152727SrcJsKendoBinder) {}, function (_githubKendoLabsBowerKendoUi20152727SrcJsKendoFx) {}, function (_githubKendoLabsBowerKendoUi20152727SrcJsKendoResponsivepanel) {}, function (_githubKendoLabsBowerKendoUi20152727SrcJsKendoAutocomplete) {}, function (_githubKendoLabsBowerKendoUi20152727SrcJsKendoMobileListview) {}, function (_githubKendoLabsBowerKendoUi20152727SrcJsKendoMobileButton) {}, function (_githubKendoLabsBowerKendoUi20152727SrcJsKendoMobileNavbar) {}, function (_githubKendoLabsBowerKendoUi20152727SrcJsKendoTouch) {}],
    execute: function () {}
  };
});
System.register('src/components/search-history', ['npm:babel-runtime@5.8.3/helpers/get', 'npm:babel-runtime@5.8.3/helpers/inherits', 'npm:babel-runtime@5.8.3/helpers/class-call-check', 'src/components/component', 'src/dataSources/search-history-dataSource'], function (_export) {
	var _get, _inherits, _classCallCheck, Component, searchHistoryDataSource, observable, template, SearchHistory;

	return {
		setters: [function (_npmBabelRuntime583HelpersGet) {
			_get = _npmBabelRuntime583HelpersGet['default'];
		}, function (_npmBabelRuntime583HelpersInherits) {
			_inherits = _npmBabelRuntime583HelpersInherits['default'];
		}, function (_npmBabelRuntime583HelpersClassCallCheck) {
			_classCallCheck = _npmBabelRuntime583HelpersClassCallCheck['default'];
		}, function (_srcComponentsComponent) {
			Component = _srcComponentsComponent['default'];
		}, function (_srcDataSourcesSearchHistoryDataSource) {
			searchHistoryDataSource = _srcDataSourcesSearchHistoryDataSource['default'];
		}],
		execute: function () {
			'use strict';

			searchHistoryDataSource.online(false);

			searchHistoryDataSource.bind('change', function () {
				if (this.view().length > 0) {
					Component.trigger('artist/select', { artist: this.view()[0] });
				}
			});

			observable = kendo.observable({
				searchHistoryDataSource: searchHistoryDataSource,
				selectHistoryItem: function selectHistoryItem(e) {
					var artistId = $(e.target).data('id');
					var artist = searchHistoryDataSource.get(artistId);

					Component.trigger('artist/select', { artist: artist });

					e.preventDefault();
				}
			});
			template = '\n\t<h3>History</h3>\n\n\t<div data-bind="source: searchHistoryDataSource" data-auto-bind="false" data-template="search-history-template"></div>\n\n\t<script id="search-history-template" type="text/x-kendo-template">\n\t\t<p><a href="\\#" data-bind="click: selectHistoryItem" data-id="#: artistId #">#: artistName #</a></p>\n\t</script>';

			SearchHistory = (function (_Component) {
				_inherits(SearchHistory, _Component);

				function SearchHistory(container) {
					_classCallCheck(this, SearchHistory);

					_get(Object.getPrototypeOf(SearchHistory.prototype), 'constructor', this).call(this, container, template, observable, true);

					Component.on('artist/select', function (e, args) {
						// compare the first item, if it's this one, no need to add it again
						var firstItem = searchHistoryDataSource.at(0) || { artistId: null };

						if (args.artist.artistId !== firstItem.artistId) {
							searchHistoryDataSource.insert(0, args.artist);
							searchHistoryDataSource.sync();
						}
					});

					Component.on('searchHistory/read', function () {
						searchHistoryDataSource.read();
					});
				}

				return SearchHistory;
			})(Component);

			_export('default', SearchHistory);
		}
	};
});
System.register('src/components/albums', ['npm:babel-runtime@5.8.3/helpers/get', 'npm:babel-runtime@5.8.3/helpers/inherits', 'npm:babel-runtime@5.8.3/helpers/class-call-check', 'src/components/component', 'src/dataSources/albums-dataSource', 'src/dataSources/tracks-dataSource', 'src/itunes-api'], function (_export) {
	var _get, _inherits, _classCallCheck, Component, albumsDataSource, tracksDataSource, itunes, albumId, currentTrack, observable, template, Albums;

	return {
		setters: [function (_npmBabelRuntime583HelpersGet) {
			_get = _npmBabelRuntime583HelpersGet['default'];
		}, function (_npmBabelRuntime583HelpersInherits) {
			_inherits = _npmBabelRuntime583HelpersInherits['default'];
		}, function (_npmBabelRuntime583HelpersClassCallCheck) {
			_classCallCheck = _npmBabelRuntime583HelpersClassCallCheck['default'];
		}, function (_srcComponentsComponent) {
			Component = _srcComponentsComponent['default'];
		}, function (_srcDataSourcesAlbumsDataSource) {
			albumsDataSource = _srcDataSourcesAlbumsDataSource['default'];
		}, function (_srcDataSourcesTracksDataSource) {
			tracksDataSource = _srcDataSourcesTracksDataSource['default'];
		}, function (_srcItunesApi) {
			itunes = _srcItunesApi['default'];
		}],
		execute: function () {
			'use strict';

			albumId = null;
			currentTrack = kendo.observable({});

			tracksDataSource.bind('change', function () {
				var albums = albumsDataSource.get(albumId);
				albums.set('tracks', this.view());
			});

			observable = kendo.observable({
				isEmpty: true,
				tracksDataSource: tracksDataSource,
				albumsDataSource: albumsDataSource,
				flip: function flip(e) {

					var flippable = $(e.sender.element).closest("[data-role='flippable']").data('kendoFlippable');

					flippable.flipHorizontal();
				},

				flipStart: function flipStart(e) {

					albumId = e.data.collectionId;

					// if we're flipping the same album back over, stop the track
					if (albumId === currentTrack.collectionId) {
						Component.trigger('player/pause');
						currentTrack.set('isPlaying', false);
					}

					// only make a remote call for tracks if there are not yet any
					// tracks associated with this album
					if (e.data.tracks.length > 0) {
						return;
					} else {
						tracksDataSource.read({ id: e.data.collectionId });
					}
				},

				play: function play(e) {

					currentTrack.set('isPlaying', false);

					currentTrack = e.data;

					Component.trigger('player/play', currentTrack);
					currentTrack.set('isPlaying', true);
				},

				stop: function stop(e) {
					Component.trigger('player/stop');
					e.data.set('isPlaying', false);
				},

				search: function search(e) {
					Component.trigger('open/search');
					e.preventDefault();
				}
			});
			template = '\n\t<div>\n\t  <div class="albums" data-bind="source: albumsDataSource" data-template="albums-template">\n\t  </div>\n\t  <div class="empty" data-bind="visible: isEmpty">\n\t    <a href="#" data-bind="click: search"><i class="fa fa-music"></i></a>\n\t  </div>\n\t</div>\n\n\t<script type="text/x-kendo-template" id="albums-template">\n\t  <div class="col-sm-4">\n\t    <div class="album" data-role="flippable" data-bind="events: { flipStart: flipStart }">\n\t      <div class="front" data-role="touch" data-bind="events: { tap: flip }">\n\t        <div class="col-lg-5">\n\t          <div class="album-cover">\n\t            <img class="img-circle" src="#: artworkUrl100 #">\n\t            <p><span class="badge">#: trackCount #</span> tracks</p>\n\t          </div>\n\t        </div>\n\t        <div class="col-lg-7">\n\t          <div class="row">\n\t            <div class="col-xs-12">\n\t              <h4 title="#: collectionCensoredName #"> #: collectionCensoredName #</h4>\n\t            </div>\n\t            <div class="col-xs-12 hidden-md hidden-sm">\n\t              <p>Released #: kendo.toString(releaseDate, "MMM d, yyyy") #</p>\n\t            </div>\n\t          </div>\n\t        </div>\n\t      </div>\n\t      <div class="back">\n\t        <div data-role="kendo.mobile.ui.NavBar">\n\t          <span data-role="kendo.mobile.ui.ViewTitle">Tracks</span>\n\t          <div data-role="kendo.mobile.ui.Button" data-bind="click: flip" data-align="left">Back</div>\n\t        </div> \n\t        <div class="tracks">\n\t          <ul data-role="kendo.mobile.ui.ListView" data-bind="source: tracks" data-auto-bind="false" data-template="track-template"></table>\n\t        </div>\n\t      </div>\n\t    </div>\n\t  </div>\n\t</script>\n\n\t<script type="text/x-kendo-template" id="track-template">\n\t\t<span data-role="progress-bar"></span>\n\t  <i class="fa fa-play" data-bind="click: play, invisible: isPlaying">\n\t    <span> #: trackName #</span>\n\t  </i>\n\t  <i class="fa fa-pause" data-bind="click: stop, visible: isPlaying">\n\t    <span> #: trackName #</span>\n\t  </i>\n\t</script>';

			Albums = (function (_Component) {
				_inherits(Albums, _Component);

				function Albums(container) {
					_classCallCheck(this, Albums);

					_get(Object.getPrototypeOf(Albums.prototype), 'constructor', this).call(this, container, template, observable, true);

					Component.on('artist/select', function (e, args) {

						kendo.ui.progress($('#main'), true);

						observable.get('albumsDataSource').read({ id: args.artist.artistId });
						observable.set('isEmpty', false);
					});
				}

				return Albums;
			})(Component);

			_export('default', Albums);
		}
	};
});
System.register('src/components/artist', ['npm:babel-runtime@5.8.3/helpers/get', 'npm:babel-runtime@5.8.3/helpers/inherits', 'npm:babel-runtime@5.8.3/helpers/class-call-check', 'src/components/component', 'src/components/albums'], function (_export) {
	var _get, _inherits, _classCallCheck, Component, Album, observable, template, Artist;

	return {
		setters: [function (_npmBabelRuntime583HelpersGet) {
			_get = _npmBabelRuntime583HelpersGet['default'];
		}, function (_npmBabelRuntime583HelpersInherits) {
			_inherits = _npmBabelRuntime583HelpersInherits['default'];
		}, function (_npmBabelRuntime583HelpersClassCallCheck) {
			_classCallCheck = _npmBabelRuntime583HelpersClassCallCheck['default'];
		}, function (_srcComponentsComponent) {
			Component = _srcComponentsComponent['default'];
		}, function (_srcComponentsAlbums) {
			Album = _srcComponentsAlbums['default'];
		}],
		execute: function () {
			'use strict';

			observable = kendo.observable({
				artistName: null
			});
			template = '\n\t<div id="results">\n\t\t<div class="row-fluid">\n\t\t  <div id="artist" class="col-xs-12 header">\n\t\t  \t<i id="search-button" class="fa fa-search k-rpanel-toggle"></i>\n\t\t    <h1 data-bind="html: artistName"></h1>\n\t\t  </div>\n\t\t</div>\n\t</div>';

			Artist = (function (_Component) {
				_inherits(Artist, _Component);

				function Artist(container) {
					_classCallCheck(this, Artist);

					_get(Object.getPrototypeOf(Artist.prototype), 'constructor', this).call(this, container, template, observable, true);

					Component.on('artist/select', function (e, args) {
						observable.set('artistName', args.artist.artistName);
					});

					new Album('#results');

					Component.trigger('searchHistory/read');
				}

				return Artist;
			})(Component);

			_export('default', Artist);
		}
	};
});
System.register('src/components/component', ['npm:babel-runtime@5.8.3/helpers/create-class', 'npm:babel-runtime@5.8.3/helpers/class-call-check'], function (_export) {
	var _createClass, _classCallCheck, o, Component;

	return {
		setters: [function (_npmBabelRuntime583HelpersCreateClass) {
			_createClass = _npmBabelRuntime583HelpersCreateClass['default'];
		}, function (_npmBabelRuntime583HelpersClassCallCheck) {
			_classCallCheck = _npmBabelRuntime583HelpersClassCallCheck['default'];
		}],
		execute: function () {
			'use strict';

			o = $({});

			Component = (function () {
				_createClass(Component, null, [{
					key: 'on',
					value: function on() {
						o.on.apply(o, arguments);
					}
				}, {
					key: 'off',
					value: function off() {
						o.off.apply(o, arguments);
					}
				}, {
					key: 'trigger',
					value: function trigger() {
						o.trigger.apply(o, arguments);
					}
				}]);

				function Component(container, template, observable, bindable) {
					_classCallCheck(this, Component);

					var html = undefined,
					    dom = undefined;

					if (container) {
						dom = $(template).appendTo(container);
					}

					if (bindable) {
						kendo.bind(dom, observable);
					}
				}

				return Component;
			})();

			_export('default', Component);
		}
	};
});
System.register('src/components/search-box', ['npm:babel-runtime@5.8.3/helpers/get', 'npm:babel-runtime@5.8.3/helpers/inherits', 'npm:babel-runtime@5.8.3/helpers/class-call-check', 'src/components/component', 'src/components/search-history', 'src/itunes-api'], function (_export) {
	var _get, _inherits, _classCallCheck, Component, SearchHistory, itunes, observable, template, SearchBox;

	return {
		setters: [function (_npmBabelRuntime583HelpersGet) {
			_get = _npmBabelRuntime583HelpersGet['default'];
		}, function (_npmBabelRuntime583HelpersInherits) {
			_inherits = _npmBabelRuntime583HelpersInherits['default'];
		}, function (_npmBabelRuntime583HelpersClassCallCheck) {
			_classCallCheck = _npmBabelRuntime583HelpersClassCallCheck['default'];
		}, function (_srcComponentsComponent) {
			Component = _srcComponentsComponent['default'];
		}, function (_srcComponentsSearchHistory) {
			SearchHistory = _srcComponentsSearchHistory['default'];
		}, function (_srcItunesApi) {
			itunes = _srcItunesApi['default'];
		}],
		execute: function () {
			'use strict';

			observable = kendo.observable({
				selectArtist: function selectArtist(e) {
					var artist = e.sender.dataItem(e.item.index());
					Component.trigger('artist/select', { artist: artist });
				},
				searchDataSource: new kendo.data.DataSource({
					transport: {
						read: {
							url: function url() {
								return itunes.SEARCH;
							},
							dataType: 'jsonp',
							data: function data(options) {
								return {
									media: 'music',
									country: 'US',
									entity: 'musicArtist',
									term: options.filter.filter[0].value
								};
							}
						}
					},
					schema: {
						data: 'results'
					},
					serverFiltering: true
				})
			});
			template = '\n\t<div id="search" class="search" data-role="responsivepanel" data-breakpoint="1500">\n\t  <h1>Search</h1>\n\t  <div class="search-box-container">\n\t  \t<input class="search-box" type="text" data-role="autocomplete" data-bind="source: searchDataSource, events: { select: selectArtist }" data-text-field="artistName" data-value-field="artistId">\n\t  </div>\n\t  <div id="search-history"></div>\n\t</div>';

			SearchBox = (function (_Component) {
				_inherits(SearchBox, _Component);

				function SearchBox(container) {
					var _this = this;

					_classCallCheck(this, SearchBox);

					_get(Object.getPrototypeOf(SearchBox.prototype), 'constructor', this).call(this, container, template, observable, true);

					this.sidebarInstance = $('#search').data('kendoResponsivePanel');

					Component.on('open/search', function () {
						_this.sidebarInstance.open();
					});

					new SearchHistory('#search-history');
				}

				return SearchBox;
			})(Component);

			_export('default', SearchBox);
		}
	};
});
System.register('src/main', ['github:components/jquery@2.1.4', 'src/kendo', 'github:burkeholland/kendo-flippable@master', 'src/components/search-box', 'src/components/artist', 'src/components/player'], function (_export) {
  'use strict';

  var SearchBox, Artist, Player;
  return {
    setters: [function (_githubComponentsJquery214) {}, function (_srcKendo) {}, function (_githubBurkehollandKendoFlippableMaster) {}, function (_srcComponentsSearchBox) {
      SearchBox = _srcComponentsSearchBox['default'];
    }, function (_srcComponentsArtist) {
      Artist = _srcComponentsArtist['default'];
    }, function (_srcComponentsPlayer) {
      Player = _srcComponentsPlayer['default'];
    }],
    execute: function () {

      new Player(document.body);

      new SearchBox('#main');

      new Artist('#main');

      kendo.ui.progress($('.container'), true);
    }
  };
});
(function() {
  var loader = System;
  if (typeof indexOf == 'undefined')
    indexOf = Array.prototype.indexOf;

  function readGlobalProperty(p, value) {
    var pParts = p.split('.');
    while (pParts.length)
      value = value[pParts.shift()];
    return value;
  }

  var ignoredGlobalProps = ['sessionStorage', 'localStorage', 'clipboardData', 'frames', 'external'];

  var hasOwnProperty = loader.global.hasOwnProperty;

  function iterateGlobals(callback) {
    if (Object.keys)
      Object.keys(loader.global).forEach(callback);
    else
      for (var g in loader.global) {
        if (!hasOwnProperty.call(loader.global, g))
          continue;
        callback(g);
      }
  }

  function forEachGlobal(callback) {
    iterateGlobals(function(globalName) {
      if (indexOf.call(ignoredGlobalProps, globalName) != -1)
        return;
      try {
        var value = loader.global[globalName];
      }
      catch(e) {
        ignoredGlobalProps.push(globalName);
      }
      callback(globalName, value);
    });
  }

  var moduleGlobals = {};

  var globalSnapshot;

  loader.set('@@global-helpers', loader.newModule({
    prepareGlobal: function(moduleName, deps) {
      // first, we add all the dependency modules to the global
      for (var i = 0; i < deps.length; i++) {
        var moduleGlobal = moduleGlobals[deps[i]];
        if (moduleGlobal)
          for (var m in moduleGlobal)
            loader.global[m] = moduleGlobal[m];
      }

      // now store a complete copy of the global object
      // in order to detect changes
      globalSnapshot = {};
      
      forEachGlobal(function(name, value) {
        globalSnapshot[name] = value;
      });
    },
    retrieveGlobal: function(moduleName, exportName, init) {
      var singleGlobal;
      var multipleExports;
      var exports = {};

      // run init
      if (init)
        singleGlobal = init.call(loader.global);

      // check for global changes, creating the globalObject for the module
      // if many globals, then a module object for those is created
      // if one global, then that is the module directly
      else if (exportName) {
        var firstPart = exportName.split('.')[0];
        singleGlobal = readGlobalProperty(exportName, loader.global);
        exports[firstPart] = loader.global[firstPart];
      }

      else {
        forEachGlobal(function(name, value) {
          if (globalSnapshot[name] === value)
            return;
          if (typeof value === 'undefined')
            return;
          exports[name] = value;
          if (typeof singleGlobal !== 'undefined') {
            if (!multipleExports && singleGlobal !== value)
              multipleExports = true;
          }
          else {
            singleGlobal = value;
          }
        });
      }

      moduleGlobals[moduleName] = exports;

      return multipleExports ? exports : singleGlobal;
    }
  }));
})();
});
//# sourceMappingURL=app.js.map