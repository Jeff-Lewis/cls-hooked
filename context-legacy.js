'use strict';

const util = require('util');
const assert = require('assert');
const wrapEmitter = require('emitter-listener');
const asyncHook = require('async-hook-jl');

const CONTEXTS_SYMBOL = 'cls@contexts';
const ERROR_SYMBOL = 'error@context';

//const trace = [];

const invertedProviders = [];
for (let key in asyncHook.providers) {
  invertedProviders[asyncHook.providers[key]] = key;
}

const DEBUG_CLS_HOOKED = process.env.DEBUG_CLS_HOOKED;

let currentUid = -1;

module.exports = {
  getNamespace: getNamespace,
  createNamespace: createNamespace,
  destroyNamespace: destroyNamespace,
  reset: reset,
  //trace: trace,
  ERROR_SYMBOL: ERROR_SYMBOL
};

function Namespace(name) {
  this.name = name;
  // changed in 2.7: no default context
  this.active = null;
  this._set = [];
  this.id = null;
  this._contexts = new Map();
}

Namespace.prototype.set = function set(key, value) {
  if (!this.active) {
    throw new Error('No context available. ns.run() or ns.bind() must be called first.');
  }

  if (DEBUG_CLS_HOOKED) {
    debug2('    SETTING KEY:' + key + '=' + value + ' in ns:' + this.name + ' uid:' + currentUid + ' active:' +
      util.inspect(this.active, true));
  }
  this.active[key] = value;
  return value;
};

Namespace.prototype.get = function get(key) {
  if (!this.active) {
    if (DEBUG_CLS_HOOKED) {
      debug2('    GETTING KEY:' + key + '=undefined' + ' ' + this.name + ' uid:' + currentUid + ' active:' +
        util.inspect(this.active, true));
    }
    return undefined;
  }
  if (DEBUG_CLS_HOOKED) {
    debug2('    GETTING KEY:' + key + '=' + this.active[key] + ' ' + this.name + ' uid:' + currentUid + ' active:' +
      util.inspect(this.active, true));
  }
  return this.active[key];
};

Namespace.prototype.createContext = function createContext() {
  if (DEBUG_CLS_HOOKED) {
    debug2('   CREATING Context: ' + this.name + ' uid:' + currentUid + ' len:' + this._set.length + ' ' + ' active:' +
      util.inspect(this.active, true, 2, true));
  }

  let context = Object.create(this.active ? this.active : Object.prototype);
  context._ns_name = this.name;
  context.id = currentUid;

  if (DEBUG_CLS_HOOKED) {
    debug2('   CREATED Context: ' + this.name + ' uid:' + currentUid + ' len:' + this._set.length + ' ' + ' context:' +
      util.inspect(context, true, 2, true));
  }

  return context;
};

Namespace.prototype.run = function run(fn) {
  let context = this.createContext();
  this.enter(context);
  try {
    if (DEBUG_CLS_HOOKED) {
      debug2(' BEFORE RUN: ' + this.name + ' uid:' + currentUid + ' len:' + this._set.length + ' ' +
        util.inspect(context));
    }
    fn(context);
    return context;
  }
  catch (exception) {
    try {
      //handle exception(throw by user) which is not an error object.
      //exception: null, undefined, string(when 'use strict') etc.
      exception[ERROR_SYMBOL] = context;
    } catch (ex) {}
    throw exception;
  }
  finally {
    if (DEBUG_CLS_HOOKED) {
      debug2(' AFTER RUN: ' + this.name + ' uid:' + currentUid + ' len:' + this._set.length + ' ' +
        util.inspect(context));
    }
    this.exit(context);
  }
};

Namespace.prototype.runAndReturn = function runAndReturn(fn) {
  var value;
  this.run(function (context) {
    value = fn(context);
  });
  return value;
};

/**
 * Uses global Promise and assumes Promise is cls friendly or wrapped already.
 * @param {function} fn
 * @returns {*}
 */
Namespace.prototype.runPromise = function runPromise(fn) {
  let context = this.createContext();
  this.enter(context);

  let promise = fn(context);
  if (!promise || !promise.then || !promise.catch) {
    throw new Error('fn must return a promise.');
  }

  if (DEBUG_CLS_HOOKED) {
    debug2(' BEFORE runPromise: ' + this.name + ' uid:' + currentUid + ' len:' + this._set.length + ' ' +
      util.inspect(context));
  }

  return promise
    .then(result => {
      if (DEBUG_CLS_HOOKED) {
        debug2(' AFTER runPromise: ' + this.name + ' uid:' + currentUid + ' len:' + this._set.length + ' ' +
          util.inspect(context));
      }
      this.exit(context);
      return result;
    })
    .catch(err => {
      err[ERROR_SYMBOL] = context;
      if (DEBUG_CLS_HOOKED) {
        debug2(' AFTER runPromise: ' + this.name + ' uid:' + currentUid + ' len:' + this._set.length + ' ' +
          util.inspect(context));
      }
      this.exit(context);
      throw err;
    });
};

Namespace.prototype.bind = function bindFactory(fn, context) {
  if (!context) {
    if (!this.active) {
      context = this.createContext();
    }
    else {
      context = this.active;
    }
  }

  let self = this;
  return function clsBind() {
    self.enter(context);
    try {
      return fn.apply(this, arguments);
    }
    catch (exception) {
      try {
        //handle exception(throw by user) which is not an error object.
        //exception: null, undefined, string(when 'use strict') etc.
        exception[ERROR_SYMBOL] = context;
      } catch (ex) {}
      throw exception;
    }
    finally {
      self.exit(context);
    }
  };
};

Namespace.prototype.enter = function enter(context) {
  assert.ok(context, 'context must be provided for entering');
  if (DEBUG_CLS_HOOKED) {
    debug2('  ENTER ' + this.name + ' uid:' + currentUid + ' len:' + this._set.length + ' context: ' +
      util.inspect(context));
  }

  this._set.push(this.active);
  this.active = context;
};

Namespace.prototype.exit = function exit(context) {
  assert.ok(context, 'context must be provided for exiting');
  if (DEBUG_CLS_HOOKED) {
    debug2('  EXIT ' + this.name + ' uid:' + currentUid + ' len:' + this._set.length + ' context: ' +
      util.inspect(context));
  }

  // Fast path for most exits that are at the top of the stack
  if (this.active === context) {
    assert.ok(this._set.length, 'can\'t remove top context');
    this.active = this._set.pop();
    return;
  }

  // Fast search in the stack using lastIndexOf
  let index = this._set.lastIndexOf(context);

  if (index < 0) {
    if (DEBUG_CLS_HOOKED) {
      debug2('??ERROR?? context exiting but not entered - ignoring: ' + util.inspect(context));
    }
    assert.ok(index >= 0, 'context not currently entered; can\'t exit. \n' + util.inspect(this) + '\n' +
      util.inspect(context));
  } else {
    assert.ok(index, 'can\'t remove top context');
    this._set.splice(index, 1);
  }
};

Namespace.prototype.bindEmitter = function bindEmitter(emitter) {
  assert.ok(emitter.on && emitter.addListener && emitter.emit, 'can only bind real EEs');

  let namespace = this;
  let thisSymbol = 'context@' + this.name;

  // Capture the context active at the time the emitter is bound.
  function attach(listener) {
    if (!listener) {
      return;
    }
    if (!listener[CONTEXTS_SYMBOL]) {
      listener[CONTEXTS_SYMBOL] = Object.create(null);
    }

    listener[CONTEXTS_SYMBOL][thisSymbol] = {
      namespace: namespace,
      context: namespace.active
    };
  }

  // At emit time, bind the listener within the correct context.
  function bind(unwrapped) {
    if (!(unwrapped && unwrapped[CONTEXTS_SYMBOL])) {
      return unwrapped;
    }

    let wrapped = unwrapped;
    let unwrappedContexts = unwrapped[CONTEXTS_SYMBOL];
    Object.keys(unwrappedContexts).forEach(function (name) {
      let thunk = unwrappedContexts[name];
      wrapped = thunk.namespace.bind(wrapped, thunk.context);
    });
    return wrapped;
  }

  wrapEmitter(emitter, attach, bind);
};

/**
 * If an error comes out of a namespace, it will have a context attached to it.
 * This function knows how to find it.
 *
 * @param {Error} exception Possibly annotated error.
 */
Namespace.prototype.fromException = function fromException(exception) {
  return exception[ERROR_SYMBOL];
};

function getNamespace(name) {
  return process.namespaces[name];
}

function createNamespace(name) {
  assert.ok(name, 'namespace must be given a name.');

  if (DEBUG_CLS_HOOKED) {
    debug2('CREATING NAMESPACE ' + name);
  }
  let namespace = new Namespace(name);
  namespace.id = currentUid;

  asyncHook.addHooks({
    init(uid, handle, provider, parentUid, parentHandle) {
      //parentUid = parentUid || currentUid;  // Suggested usage but appears to work better for tracing modules.
      currentUid = uid;

      //CHAIN Parent's Context onto child if none exists. This is needed to pass net-events.spec
      if (parentUid) {
        namespace._contexts.set(uid, namespace._contexts.get(parentUid));
        if (DEBUG_CLS_HOOKED) {
          debug2('PARENTID: ' + name + ' uid:' + uid + ' parent:' + parentUid + ' provider:' + provider);
        }
      } else {
        namespace._contexts.set(currentUid, namespace.active);
      }

      if (DEBUG_CLS_HOOKED) {
        debug2('INIT ' + name + ' uid:' + uid + ' parent:' + parentUid + ' provider:' + invertedProviders[provider]
          + ' active:' + util.inspect(namespace.active, true));
      }

    },
    pre(uid, handle) {
      currentUid = uid;
      let context = namespace._contexts.get(uid);
      if (context) {
        if (DEBUG_CLS_HOOKED) {
          debug2(' PRE ' + name + ' uid:' + uid + ' handle:' + getFunctionName(handle) + ' context:' +
            util.inspect(context));
        }

        namespace.enter(context);
      } else {
        if (DEBUG_CLS_HOOKED) {
          debug2(' PRE MISSING CONTEXT ' + name + ' uid:' + uid + ' handle:' + getFunctionName(handle));
        }
      }
    },
    post(uid, handle) {
      currentUid = uid;
      let context = namespace._contexts.get(uid);
      if (context) {
        if (DEBUG_CLS_HOOKED) {
          debug2(' POST ' + name + ' uid:' + uid + ' handle:' + getFunctionName(handle) + ' context:' +
            util.inspect(context));
        }

        namespace.exit(context);
      } else {
        if (DEBUG_CLS_HOOKED) {
          debug2(' POST MISSING CONTEXT ' + name + ' uid:' + uid + ' handle:' + getFunctionName(handle));
        }
      }
    },
    destroy(uid) {
      currentUid = uid;

      if (DEBUG_CLS_HOOKED) {
        debug2('DESTROY ' + name + ' uid:' + uid + ' context:' + util.inspect(namespace._contexts.get(currentUid))
          + ' active:' + util.inspect(namespace.active, true));
      }

      namespace._contexts.delete(uid);
    }
  });

  process.namespaces[name] = namespace;
  return namespace;
}

function destroyNamespace(name) {
  let namespace = getNamespace(name);

  assert.ok(namespace, 'can\'t delete nonexistent namespace! "' + name + '"');
  assert.ok(namespace.id, 'don\'t assign to process.namespaces directly! ' + util.inspect(namespace));

  process.namespaces[name] = null;
}

function reset() {
  // must unregister async listeners
  if (process.namespaces) {
    Object.keys(process.namespaces).forEach(function (name) {
      destroyNamespace(name);
    });
  }
  process.namespaces = Object.create(null);
}

process.namespaces = {};

if (asyncHook._state && !asyncHook._state.enabled) {
  asyncHook.enable();
}

function debug2(msg) {
  if (process.env.DEBUG) {
    process._rawDebug(msg);
  }
}


/*function debug(from, ns) {
 process._rawDebug('DEBUG: ' + util.inspect({
 from: from,
 currentUid: currentUid,
 context: ns ? ns._contexts.get(currentUid) : 'no ns'
 }, true, 2, true));
 }*/


function getFunctionName(fn) {
  if (!fn) {
    return fn;
  }
  if (typeof fn === 'function') {
    if (fn.name) {
      return fn.name;
    }
    return (fn.toString().trim().match(/^function\s*([^\s(]+)/) || [])[1];
  } else if (fn.constructor && fn.constructor.name) {
    return fn.constructor.name;
  }
}


// Add back to callstack
if (DEBUG_CLS_HOOKED) {
  var stackChain = require('stack-chain');
  for (var modifier in stackChain.filter._modifiers) {
    stackChain.filter.deattach(modifier);
  }
}
