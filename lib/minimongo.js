var _ = require('lodash');
var BetterObjectId = require('./BetterObjectId.js');
var Random = require('./random.js');
var EJSON = require('./ejson.js');
var JSON = require('JSON2');

var Meteor = {};
Meteor.defer = function(fn){
  fn();
}
// An even simpler queue of tasks than the fiber-enabled one.  This one just
// runs all the tasks when you call runTask or flush, synchronously.
var SynchronousQueue = function () {
  var self = this;
  self._tasks = [];
  self._running = false;
};

_.extend(SynchronousQueue.prototype, {
  runTask: function (task) {
    var self = this;
    if (!self.safeToRunTask())
      throw new Error("Could not synchronously run a task from a running task");
    self._tasks.push(task);
    var tasks = self._tasks;
    self._tasks = [];
    self._running = true;
    try {
      while (!_.isEmpty(tasks)) {
        var t = tasks.shift();
        try {
          t();
        } catch (e) {
          if (_.isEmpty(tasks)) {
            // this was the last task, that is, the one we're calling runTask
            // for.
            throw e;
          } else {
            Meteor._debug("Exception in queued task: " + e.stack);
          }
        }
      }
    } finally {
      self._running = false;
    }
  },

  queueTask: function (task) {
    var self = this;
    var wasEmpty = _.isEmpty(self._tasks);
    self._tasks.push(task);
    // Intentionally not using Meteor.setTimeout, because it doesn't like runing
    // in stubs for now.
    if (wasEmpty)
      setTimeout(_.bind(self.flush, self), 0);
  },

  flush: function () {
    var self = this;
    self.runTask(function () {});
  },

  drain: function () {
    var self = this;
    if (!self.safeToRunTask())
      return;
    while (!_.isEmpty(self._tasks)) {
      self.flush();
    }
  },

  safeToRunTask: function () {
    var self = this;
    return !self._running;
  }
});


// XXX type checking on selectors (graceful error if malformed)

// LocalCollection: a set of documents that supports queries and modifiers.

// Cursor: a specification for a particular subset of documents, w/
// a defined order, limit, and offset.  creating a Cursor with LocalCollection.find(),

// ObserveHandle: the return value of a live query.

LocalCollection = function (name) {
  var self = this;
  self.name = name;
  // _id -> document (also containing id)
  self._docs = new LocalCollection._IdMap;

  self._observeQueue = new SynchronousQueue();

  self.next_qid = 1; // live query id generator

  // qid -> live query object. keys:
  //  ordered: bool. ordered queries have addedBefore/movedBefore callbacks.
  //  results: array (ordered) or object (unordered) of current results
  //    (aliased with self._docs!)
  //  resultsSnapshot: snapshot of results. null if not paused.
  //  cursor: Cursor object for the query.
  //  selector, sorter, (callbacks): functions
  self.queries = {};

  // null if not saving originals; an IdMap from id to original document value if
  // saving originals. See comments before saveOriginals().
  self._savedOriginals = null;

  // True when observers are paused and we should not send callbacks.
  self.paused = false;
};

Minimongo = {};

// Object exported only for unit testing.
// Use it to export private functions to test in Tinytest.
MinimongoTest = {};

LocalCollection._applyChanges = function (doc, changeFields) {
  _.each(changeFields, function (value, key) {
    if (value === undefined)
      delete doc[key];
    else
      doc[key] = value;
  });
};

MinimongoError = function (message) {
  var e = new Error(message);
  e.name = "MinimongoError";
  return e;
};


// options may include sort, skip, limit, reactive
// sort may be any of these forms:
//     {a: 1, b: -1}
//     [["a", "asc"], ["b", "desc"]]
//     ["a", ["b", "desc"]]
//   (in the first form you're beholden to key enumeration order in
//   your javascript VM)
//
// reactive: if given, and false, don't register with Deps (default
// is true)
//
// XXX possibly should support retrieving a subset of fields? and
// have it be a hint (ignored on the client, when not copying the
// doc?)
//
// XXX sort does not yet support subkeys ('a.b') .. fix that!
// XXX add one more sort form: "key"
// XXX tests
LocalCollection.prototype.find = function (selector, options) {
  // default syntax for everything is to omit the selector argument.
  // but if selector is explicitly passed in as false or undefined, we
  // want a selector that matches nothing.
  if (arguments.length === 0)
    selector = {};
  return new LocalCollection.Cursor(this, selector, options);
};

// don't call this ctor directly.  use LocalCollection.find().
LocalCollection.Cursor = function (collection, selector, options) {
  var self = this;
  if (!options) options = {};

  this.collection = collection;

  if (LocalCollection._selectorIsId(selector)) {
    // stash for fast path
    self._selectorId = selector;
    self.matcher = new Minimongo.Matcher(selector, self);
    self.sorter = undefined;
  } else {
    self._selectorId = undefined;
    self.matcher = new Minimongo.Matcher(selector, self);
    self.sorter = (self.matcher.hasGeoQuery() || options.sort) ?
      new Sorter(options.sort || []) : null;
  }
  self.skip = options.skip;
  self.limit = options.limit;
  self.fields = options.fields;

  if (self.fields)
    self.projectionFn = LocalCollection._compileProjection(self.fields);

  self._transform = LocalCollection.wrapTransform(options.transform);

  // db_objects is an array of the objects that match the cursor. (It's always
  // an array, never an IdMap: LocalCollection.Cursor is always ordered.)
  self.db_objects = null;
  self.cursor_pos = 0;

  // by default, queries register w/ Deps when it is available.
  if (typeof Deps !== "undefined")
    self.reactive = (options.reactive === undefined) ? true : options.reactive;
};

LocalCollection.Cursor.prototype.rewind = function () {
  var self = this;
  self.db_objects = null;
  self.cursor_pos = 0;
};

LocalCollection.prototype.findOne = function (selector, options) {
  if (arguments.length === 0)
    selector = {};

  // NOTE: by setting limit 1 here, we end up using very inefficient
  // code that recomputes the whole query on each update. The upside is
  // that when you reactively depend on a findOne you only get
  // invalidated when the found object changes, not any object in the
  // collection. Most findOne will be by id, which has a fast path, so
  // this might not be a big deal. In most cases, invalidation causes
  // the called to re-query anyway, so this should be a net performance
  // improvement.
  options = options || {};
  options.limit = 1;

  return this.find(selector, options).fetch()[0];
};

LocalCollection.Cursor.prototype.forEach = function (callback, thisArg) {
  var self = this;

  if (self.db_objects === null)
    self.db_objects = self._getRawObjects({ordered: true});

  if (self.reactive)
    self._depend({
      addedBefore: true,
      removed: true,
      changed: true,
      movedBefore: true});

  while (self.cursor_pos < self.db_objects.length) {
    var elt = EJSON.clone(self.db_objects[self.cursor_pos]);
    if (self.projectionFn)
      elt = self.projectionFn(elt);
    if (self._transform)
      elt = self._transform(elt);
    callback.call(thisArg, elt, self.cursor_pos, self);
    ++self.cursor_pos;
  }
};

LocalCollection.Cursor.prototype.getTransform = function () {
  return this._transform;
};

LocalCollection.Cursor.prototype.map = function (callback, thisArg) {
  var self = this;
  var res = [];
  self.forEach(function (doc, index) {
    res.push(callback.call(thisArg, doc, index, self));
  });
  return res;
};

LocalCollection.Cursor.prototype.fetch = function () {
  var self = this;
  var res = [];
  self.forEach(function (doc) {
    res.push(doc);
  });
  return res;
};

LocalCollection.Cursor.prototype.count = function () {
  var self = this;

  if (self.reactive)
    self._depend({added: true, removed: true},
                 true /* allow the observe to be unordered */);

  if (self.db_objects === null)
    self.db_objects = self._getRawObjects({ordered: true});

  return self.db_objects.length;
};

LocalCollection.Cursor.prototype._publishCursor = function (sub) {
  var self = this;
  if (! self.collection.name)
    throw new Error("Can't publish a cursor from a collection without a name.");
  var collection = self.collection.name;

  // XXX minimongo should not depend on mongo-livedata!
  return Meteor.Collection._publishCursor(self, sub, collection);
};

LocalCollection.Cursor.prototype._getCollectionName = function () {
  var self = this;
  return self.collection.name;
};

LocalCollection._observeChangesCallbacksAreOrdered = function (callbacks) {
  if (callbacks.added && callbacks.addedBefore)
    throw new Error("Please specify only one of added() and addedBefore()");
  return !!(callbacks.addedBefore || callbacks.movedBefore);
};

LocalCollection._observeCallbacksAreOrdered = function (callbacks) {
  if (callbacks.addedAt && callbacks.added)
    throw new Error("Please specify only one of added() and addedAt()");
  if (callbacks.changedAt && callbacks.changed)
    throw new Error("Please specify only one of changed() and changedAt()");
  if (callbacks.removed && callbacks.removedAt)
    throw new Error("Please specify only one of removed() and removedAt()");

  return !!(callbacks.addedAt || callbacks.movedTo || callbacks.changedAt
            || callbacks.removedAt);
};

// the handle that comes back from observe.
LocalCollection.ObserveHandle = function () {};

// options to contain:
//  * callbacks for observe():
//    - addedAt (document, atIndex)
//    - added (document)
//    - changedAt (newDocument, oldDocument, atIndex)
//    - changed (newDocument, oldDocument)
//    - removedAt (document, atIndex)
//    - removed (document)
//    - movedTo (document, oldIndex, newIndex)
//
// attributes available on returned query handle:
//  * stop(): end updates
//  * collection: the collection this query is querying
//
// iff x is a returned query handle, (x instanceof
// LocalCollection.ObserveHandle) is true
//
// initial results delivered through added callback
// XXX maybe callbacks should take a list of objects, to expose transactions?
// XXX maybe support field limiting (to limit what you're notified on)

_.extend(LocalCollection.Cursor.prototype, {
  observe: function (options) {
    var self = this;
    return LocalCollection._observeFromObserveChanges(self, options);
  },
  observeChanges: function (options) {
    var self = this;

    var ordered = LocalCollection._observeChangesCallbacksAreOrdered(options);

    // there are several places that assume you aren't combining skip/limit with
    // unordered observe.  eg, update's EJSON.clone, and the "there are several"
    // comment in _modifyAndNotify
    // XXX allow skip/limit with unordered observe
    if (!options._allow_unordered && !ordered && (self.skip || self.limit))
      throw new Error("must use ordered observe with skip or limit");

    if (self.fields && (self.fields._id === 0 || self.fields._id === false))
      throw Error("You may not observe a cursor with {fields: {_id: 0}}");

    var query = {
      matcher: self.matcher, // not fast pathed
      sorter: ordered && self.sorter,
      distances: (
        self.matcher.hasGeoQuery() && ordered && new LocalCollection._IdMap),
      resultsSnapshot: null,
      ordered: ordered,
      cursor: self,
      projectionFn: self.projectionFn
    };
    var qid;

    // Non-reactive queries call added[Before] and then never call anything
    // else.
    if (self.reactive) {
      qid = self.collection.next_qid++;
      self.collection.queries[qid] = query;
    }
    query.results = self._getRawObjects({
      ordered: ordered, distances: query.distances});
    if (self.collection.paused)
      query.resultsSnapshot = (ordered ? [] : new LocalCollection._IdMap);

    // wrap callbacks we were passed. callbacks only fire when not paused and
    // are never undefined
    // Filters out blacklisted fields according to cursor's projection.
    // XXX wrong place for this?

    // furthermore, callbacks enqueue until the operation we're working on is
    // done.
    var wrapCallback = function (f, fieldsIndex, ignoreEmptyFields) {
      if (!f)
        return function () {};
      return function (/*args*/) {
        var context = this;
        var args = arguments;

        if (self.collection.paused)
          return;

        if (fieldsIndex !== undefined && self.projectionFn) {
          args[fieldsIndex] = self.projectionFn(args[fieldsIndex]);
          if (ignoreEmptyFields && _.isEmpty(args[fieldsIndex]))
            return;
        }

        self.collection._observeQueue.queueTask(function () {
          f.apply(context, args);
        });
      };
    };
    query.added = wrapCallback(options.added, 1);
    query.changed = wrapCallback(options.changed, 1, true);
    query.removed = wrapCallback(options.removed);
    if (ordered) {
      query.addedBefore = wrapCallback(options.addedBefore, 1);
      query.movedBefore = wrapCallback(options.movedBefore);
    }

    if (!options._suppress_initial && !self.collection.paused) {
      // XXX unify ordered and unordered interface
      var each = ordered
            ? _.bind(_.each, null, query.results)
            : _.bind(query.results.forEach, query.results);
      each(function (doc) {
        var fields = EJSON.clone(doc);

        delete fields._id;
        if (ordered)
          query.addedBefore(doc._id, fields, null);
        query.added(doc._id, fields);
      });
    }

    var handle = new LocalCollection.ObserveHandle;
    _.extend(handle, {
      collection: self.collection,
      stop: function () {
        if (self.reactive)
          delete self.collection.queries[qid];
      }
    });

    if (self.reactive && Deps.active) {
      // XXX in many cases, the same observe will be recreated when
      // the current autorun is rerun.  we could save work by
      // letting it linger across rerun and potentially get
      // repurposed if the same observe is performed, using logic
      // similar to that of Meteor.subscribe.
      Deps.onInvalidate(function () {
        handle.stop();
      });
    }
    // run the observe callbacks resulting from the initial contents
    // before we leave the observe.
    self.collection._observeQueue.drain();

    return handle;
  }
});

// Returns a collection of matching objects, but doesn't deep copy them.
//
// If ordered is set, returns a sorted array, respecting sorter, skip, and limit
// properties of the query.  if sorter is falsey, no sort -- you get the natural
// order.
//
// If ordered is not set, returns an object mapping from ID to doc (sorter, skip
// and limit should not be set).
//
// If ordered is set and this cursor is a $near geoquery, then this function
// will use an _IdMap to track each distance from the $near argument point in
// order to use it as a sort key. If an _IdMap is passed in the 'distances'
// argument, this function will clear it and use it for this purpose (otherwise
// it will just create its own _IdMap). The observeChanges implementation uses
// this to remember the distances after this function returns.
LocalCollection.Cursor.prototype._getRawObjects = function (options) {
  var self = this;
  options = options || {};

  // XXX use OrderedDict instead of array, and make IdMap and OrderedDict
  // compatible
  var results = options.ordered ? [] : new LocalCollection._IdMap;

  // fast path for single ID value
  if (self._selectorId !== undefined) {
    // If you have non-zero skip and ask for a single id, you get
    // nothing. This is so it matches the behavior of the '{_id: foo}'
    // path.
    if (self.skip)
      return results;

    var selectedDoc = self.collection._docs.get(self._selectorId);
    if (selectedDoc) {
      if (options.ordered)
        results.push(selectedDoc);
      else
        results.set(self._selectorId, selectedDoc);
    }
    return results;
  }

  // slow path for arbitrary selector, sort, skip, limit

  // in the observeChanges case, distances is actually part of the "query" (ie,
  // live results set) object.  in other cases, distances is only used inside
  // this function.
  var distances;
  if (self.matcher.hasGeoQuery() && options.ordered) {
    if (options.distances) {
      distances = options.distances;
      distances.clear();
    } else {
      distances = new LocalCollection._IdMap();
    }
  }

  self.collection._docs.forEach(function (doc, id) {
    var matchResult = self.matcher.documentMatches(doc);
    if (matchResult.result) {
      if (options.ordered) {
        results.push(doc);
        if (distances && matchResult.distance !== undefined)
          distances.set(id, matchResult.distance);
      } else {
        results.set(id, doc);
      }
    }
    // Fast path for limited unsorted queries.
    // XXX 'length' check here seems wrong for ordered
    if (self.limit && !self.skip && !self.sorter &&
        results.length === self.limit)
      return false;  // break
    return true;  // continue
  });

  if (!options.ordered)
    return results;

  if (self.sorter) {
    var comparator = self.sorter.getComparator({distances: distances});
    results.sort(comparator);
  }

  var idx_start = self.skip || 0;
  var idx_end = self.limit ? (self.limit + idx_start) : results.length;
  return results.slice(idx_start, idx_end);
};

// XXX Maybe we need a version of observe that just calls a callback if
// anything changed.
LocalCollection.Cursor.prototype._depend = function (changers, _allow_unordered) {
  var self = this;

  if (Deps.active) {
    var v = new Deps.Dependency;
    v.depend();
    var notifyChange = _.bind(v.changed, v);

    var options = {
      _suppress_initial: true,
      _allow_unordered: _allow_unordered
    };
    _.each(['added', 'changed', 'removed', 'addedBefore', 'movedBefore'],
           function (fnName) {
             if (changers[fnName])
               options[fnName] = notifyChange;
           });

    // observeChanges will stop() when this computation is invalidated
    self.observeChanges(options);
  }
};

// XXX enforce rule that field names can't start with '$' or contain '.'
// (real mongodb does in fact enforce this)
// XXX possibly enforce that 'undefined' does not appear (we assume
// this in our handling of null and $exists)
LocalCollection.prototype.insert = function (doc, callback) {
  var self = this;
  doc = EJSON.clone(doc);

  if (!_.has(doc, '_id')) {
    // if you really want to use ObjectIDs, set this global.
    // Meteor.Collection specifies its own ids and does not use this code.
    //doc._id = LocalCollection._useOID? new LocalCollection._ObjectID() : Random.id();
    doc._id = new LocalCollection._ObjectID();
  }
  var id = doc._id;

  if (self._docs.has(id))
    throw MinimongoError("Duplicate _id '" + id + "'");

  self._saveOriginal(id, undefined);
  self._docs.set(id, doc);

  var queriesToRecompute = [];
  // trigger live queries that match
  for (var qid in self.queries) {
    var query = self.queries[qid];
    var matchResult = query.matcher.documentMatches(doc);
    if (matchResult.result) {
      if (query.distances && matchResult.distance !== undefined)
        query.distances.set(id, matchResult.distance);
      if (query.cursor.skip || query.cursor.limit)
        queriesToRecompute.push(qid);
      else
        LocalCollection._insertInResults(query, doc);
    }
  }

  _.each(queriesToRecompute, function (qid) {
    if (self.queries[qid])
      LocalCollection._recomputeResults(self.queries[qid]);
  });
  self._observeQueue.drain();

  // Defer because the caller likely doesn't expect the callback to be run
  // immediately.
  if (callback)
    Meteor.defer(function () {
      callback(null, id);
    });
  return id;
};

// Iterates over a subset of documents that could match selector; calls
// f(doc, id) on each of them.  Specifically, if selector specifies
// specific _id's, it only looks at those.  doc is *not* cloned: it is the
// same object that is in _docs.
LocalCollection.prototype._eachPossiblyMatchingDoc = function (selector, f) {
  var self = this;
  var specificIds = LocalCollection._idsMatchedBySelector(selector);
  if (specificIds) {
    for (var i = 0; i < specificIds.length; ++i) {
      var id = specificIds[i];
      var doc = self._docs.get(id);
      if (doc) {
        var breakIfFalse = f(doc, id);
        if (breakIfFalse === false)
          break;
      }
    }
  } else {
    self._docs.forEach(f);
  }
};

LocalCollection.prototype.remove = function (selector, callback) {
  var self = this;

  // Easy special case: if we're not calling observeChanges callbacks and we're
  // not saving originals and we got asked to remove everything, then just empty
  // everything directly.
  if (self.paused && !self._savedOriginals && EJSON.equals(selector, {})) {
    var result = self._docs.size();
    self._docs.clear();
    _.each(self.queries, function (query) {
      if (query.ordered) {
        query.results = [];
      } else {
        query.results.clear();
      }
    });
    if (callback) {
      Meteor.defer(function () {
        callback(null, result);
      });
    }
    return result;
  }

  var matcher = new Minimongo.Matcher(selector, self);
  var remove = [];
  self._eachPossiblyMatchingDoc(selector, function (doc, id) {
    if (matcher.documentMatches(doc).result)
      remove.push(id);
  });

  var queriesToRecompute = [];
  var queryRemove = [];
  for (var i = 0; i < remove.length; i++) {
    var removeId = remove[i];
    var removeDoc = self._docs.get(removeId);
    _.each(self.queries, function (query, qid) {
      if (query.matcher.documentMatches(removeDoc).result) {
        if (query.cursor.skip || query.cursor.limit)
          queriesToRecompute.push(qid);
        else
          queryRemove.push({qid: qid, doc: removeDoc});
      }
    });
    self._saveOriginal(removeId, removeDoc);
    self._docs.remove(removeId);
  }

  // run live query callbacks _after_ we've removed the documents.
  _.each(queryRemove, function (remove) {
    var query = self.queries[remove.qid];
    if (query) {
      query.distances && query.distances.remove(remove.doc._id);
      LocalCollection._removeFromResults(query, remove.doc);
    }
  });
  _.each(queriesToRecompute, function (qid) {
    var query = self.queries[qid];
    if (query)
      LocalCollection._recomputeResults(query);
  });
  self._observeQueue.drain();
  result = remove.length;
  if (callback)
    Meteor.defer(function () {
      callback(null, result);
    });
  return result;
};

// XXX atomicity: if multi is true, and one modification fails, do
// we rollback the whole operation, or what?
LocalCollection.prototype.update = function (selector, mod, options, callback) {
  var self = this;
  if (! callback && options instanceof Function) {
    callback = options;
    options = null;
  }
  if (!options) options = {};

  var matcher = new Minimongo.Matcher(selector, self);

  // Save the original results of any query that we might need to
  // _recomputeResults on, because _modifyAndNotify will mutate the objects in
  // it. (We don't need to save the original results of paused queries because
  // they already have a resultsSnapshot and we won't be diffing in
  // _recomputeResults.)
  var qidToOriginalResults = {};
  _.each(self.queries, function (query, qid) {
    // XXX for now, skip/limit implies ordered observe, so query.results is
    // always an array
    if ((query.cursor.skip || query.cursor.limit) && !query.paused)
      qidToOriginalResults[qid] = EJSON.clone(query.results);
  });
  var recomputeQids = {};

  var updateCount = 0;

  self._eachPossiblyMatchingDoc(selector, function (doc, id) {
    var queryResult = matcher.documentMatches(doc);
    if (queryResult.result) {
      // XXX Should we save the original even if mod ends up being a no-op?
      self._saveOriginal(id, doc);
      self._modifyAndNotify(doc, mod, recomputeQids, queryResult.arrayIndex);
      ++updateCount;
      if (!options.multi)
        return false;  // break
    }
    return true;
  });

  _.each(recomputeQids, function (dummy, qid) {
    var query = self.queries[qid];
    if (query)
      LocalCollection._recomputeResults(query,
                                        qidToOriginalResults[qid]);
  });
  self._observeQueue.drain();

  // If we are doing an upsert, and we didn't modify any documents yet, then
  // it's time to do an insert. Figure out what document we are inserting, and
  // generate an id for it.
  var insertedId;
  if (updateCount === 0 && options.upsert) {
    var newDoc = LocalCollection._removeDollarOperators(selector);
    LocalCollection._modify(newDoc, mod, {isInsert: true});
    if (! newDoc._id && options.insertedId)
      newDoc._id = options.insertedId;
    insertedId = self.insert(newDoc);
    updateCount = 1;
  }

  // Return the number of affected documents, or in the upsert case, an object
  // containing the number of affected docs and the id of the doc that was
  // inserted, if any.
  var result;
  if (options._returnObject) {
    result = {
      numberAffected: updateCount
    };
    if (insertedId !== undefined)
      result.insertedId = insertedId;
  } else {
    result = updateCount;
  }

  if (callback)
    Meteor.defer(function () {
      callback(null, result);
    });
  return result;
};

// A convenience wrapper on update. LocalCollection.upsert(sel, mod) is
// equivalent to LocalCollection.update(sel, mod, { upsert: true, _returnObject:
// true }).
LocalCollection.prototype.upsert = function (selector, mod, options, callback) {
  var self = this;
  if (! callback && typeof options === "function") {
    callback = options;
    options = {};
  }
  return self.update(selector, mod, _.extend({}, options, {
    upsert: true,
    _returnObject: true
  }), callback);
};

LocalCollection.prototype._modifyAndNotify = function (
    doc, mod, recomputeQids, arrayIndex) {
  var self = this;

  var matched_before = {};
  for (var qid in self.queries) {
    var query = self.queries[qid];
    if (query.ordered) {
      matched_before[qid] = query.matcher.documentMatches(doc).result;
    } else {
      // Because we don't support skip or limit (yet) in unordered queries, we
      // can just do a direct lookup.
      matched_before[qid] = query.results.has(doc._id);
    }
  }

  var old_doc = EJSON.clone(doc);

  LocalCollection._modify(doc, mod, {arrayIndex: arrayIndex});

  for (qid in self.queries) {
    query = self.queries[qid];
    var before = matched_before[qid];
    var afterMatch = query.matcher.documentMatches(doc);
    var after = afterMatch.result;
    if (after && query.distances && afterMatch.distance !== undefined)
      query.distances.set(doc._id, afterMatch.distance);

    if (query.cursor.skip || query.cursor.limit) {
      // We need to recompute any query where the doc may have been in the
      // cursor's window either before or after the update. (Note that if skip
      // or limit is set, "before" and "after" being true do not necessarily
      // mean that the document is in the cursor's output after skip/limit is
      // applied... but if they are false, then the document definitely is NOT
      // in the output. So it's safe to skip recompute if neither before or
      // after are true.)
      if (before || after)
        recomputeQids[qid] = true;
    } else if (before && !after) {
      LocalCollection._removeFromResults(query, doc);
    } else if (!before && after) {
      LocalCollection._insertInResults(query, doc);
    } else if (before && after) {
      LocalCollection._updateInResults(query, doc, old_doc);
    }
  }
};

// XXX the sorted-query logic below is laughably inefficient. we'll
// need to come up with a better datastructure for this.
//
// XXX the logic for observing with a skip or a limit is even more
// laughably inefficient. we recompute the whole results every time!

LocalCollection._insertInResults = function (query, doc) {
  var fields = EJSON.clone(doc);
  delete fields._id;
  if (query.ordered) {
    if (!query.sorter) {
      query.addedBefore(doc._id, fields, null);
      query.results.push(doc);
    } else {
      var i = LocalCollection._insertInSortedList(
        query.sorter.getComparator({distances: query.distances}),
        query.results, doc);
      var next = query.results[i+1];
      if (next)
        next = next._id;
      else
        next = null;
      query.addedBefore(doc._id, fields, next);
    }
    query.added(doc._id, fields);
  } else {
    query.added(doc._id, fields);
    query.results.set(doc._id, doc);
  }
};

LocalCollection._removeFromResults = function (query, doc) {
  if (query.ordered) {
    var i = LocalCollection._findInOrderedResults(query, doc);
    query.removed(doc._id);
    query.results.splice(i, 1);
  } else {
    var id = doc._id;  // in case callback mutates doc
    query.removed(doc._id);
    query.results.remove(id);
  }
};

LocalCollection._updateInResults = function (query, doc, old_doc) {
  if (!EJSON.equals(doc._id, old_doc._id))
    throw new Error("Can't change a doc's _id while updating");
  var changedFields = LocalCollection._makeChangedFields(doc, old_doc);
  if (!query.ordered) {
    if (!_.isEmpty(changedFields)) {
      query.changed(doc._id, changedFields);
      query.results.set(doc._id, doc);
    }
    return;
  }

  var orig_idx = LocalCollection._findInOrderedResults(query, doc);

  if (!_.isEmpty(changedFields))
    query.changed(doc._id, changedFields);
  if (!query.sorter)
    return;

  // just take it out and put it back in again, and see if the index
  // changes
  query.results.splice(orig_idx, 1);
  var new_idx = LocalCollection._insertInSortedList(
    query.sorter.getComparator({distances: query.distances}),
    query.results, doc);
  if (orig_idx !== new_idx) {
    var next = query.results[new_idx+1];
    if (next)
      next = next._id;
    else
      next = null;
    query.movedBefore && query.movedBefore(doc._id, next);
  }
};

// Recomputes the results of a query and runs observe callbacks for the
// difference between the previous results and the current results (unless
// paused). Used for skip/limit queries.
//
// When this is used by insert or remove, it can just use query.results for the
// old results (and there's no need to pass in oldResults), because these
// operations don't mutate the documents in the collection. Update needs to pass
// in an oldResults which was deep-copied before the modifier was applied.
LocalCollection._recomputeResults = function (query, oldResults) {
  if (!oldResults)
    oldResults = query.results;
  if (query.distances)
    query.distances.clear();
  query.results = query.cursor._getRawObjects({
    ordered: query.ordered, distances: query.distances});

  if (!query.paused) {
    LocalCollection._diffQueryChanges(
      query.ordered, oldResults, query.results, query);
  }
};


LocalCollection._findInOrderedResults = function (query, doc) {
  if (!query.ordered)
    throw new Error("Can't call _findInOrderedResults on unordered query");
  for (var i = 0; i < query.results.length; i++)
    if (query.results[i] === doc)
      return i;
  throw Error("object missing from query");
};

// This binary search puts a value between any equal values, and the first
// lesser value.
LocalCollection._binarySearch = function (cmp, array, value) {
  var first = 0, rangeLength = array.length;

  while (rangeLength > 0) {
    var halfRange = Math.floor(rangeLength/2);
    if (cmp(value, array[first + halfRange]) >= 0) {
      first += halfRange + 1;
      rangeLength -= halfRange + 1;
    } else {
      rangeLength = halfRange;
    }
  }
  return first;
};

LocalCollection._insertInSortedList = function (cmp, array, value) {
  if (array.length === 0) {
    array.push(value);
    return 0;
  }

  var idx = LocalCollection._binarySearch(cmp, array, value);
  array.splice(idx, 0, value);
  return idx;
};

// To track what documents are affected by a piece of code, call saveOriginals()
// before it and retrieveOriginals() after it. retrieveOriginals returns an
// object whose keys are the ids of the documents that were affected since the
// call to saveOriginals(), and the values are equal to the document's contents
// at the time of saveOriginals. (In the case of an inserted document, undefined
// is the value.) You must alternate between calls to saveOriginals() and
// retrieveOriginals().
LocalCollection.prototype.saveOriginals = function () {
  var self = this;
  if (self._savedOriginals)
    throw new Error("Called saveOriginals twice without retrieveOriginals");
  self._savedOriginals = new LocalCollection._IdMap;
};
LocalCollection.prototype.retrieveOriginals = function () {
  var self = this;
  if (!self._savedOriginals)
    throw new Error("Called retrieveOriginals without saveOriginals");

  var originals = self._savedOriginals;
  self._savedOriginals = null;
  return originals;
};

LocalCollection.prototype._saveOriginal = function (id, doc) {
  var self = this;
  // Are we even trying to save originals?
  if (!self._savedOriginals)
    return;
  // Have we previously mutated the original (and so 'doc' is not actually
  // original)?  (Note the 'has' check rather than truth: we store undefined
  // here for inserted docs!)
  if (self._savedOriginals.has(id))
    return;
  self._savedOriginals.set(id, EJSON.clone(doc));
};

// Pause the observers. No callbacks from observers will fire until
// 'resumeObservers' is called.
LocalCollection.prototype.pauseObservers = function () {
  // No-op if already paused.
  if (this.paused)
    return;

  // Set the 'paused' flag such that new observer messages don't fire.
  this.paused = true;

  // Take a snapshot of the query results for each query.
  for (var qid in this.queries) {
    var query = this.queries[qid];

    query.resultsSnapshot = EJSON.clone(query.results);
  }
};

// Resume the observers. Observers immediately receive change
// notifications to bring them to the current state of the
// database. Note that this is not just replaying all the changes that
// happened during the pause, it is a smarter 'coalesced' diff.
LocalCollection.prototype.resumeObservers = function () {
  var self = this;
  // No-op if not paused.
  if (!this.paused)
    return;

  // Unset the 'paused' flag. Make sure to do this first, otherwise
  // observer methods won't actually fire when we trigger them.
  this.paused = false;

  for (var qid in this.queries) {
    var query = self.queries[qid];
    // Diff the current results against the snapshot and send to observers.
    // pass the query object for its observer callbacks.
    LocalCollection._diffQueryChanges(
      query.ordered, query.resultsSnapshot, query.results, query);
    query.resultsSnapshot = null;
  }
  self._observeQueue.drain();
};


// NB: used by livedata
LocalCollection._idStringify = function (id) {
  if (id instanceof LocalCollection._ObjectID) {
    return id.valueOf();
  } else if (typeof id === 'string') {
    if (id === "") {
      return id;
    } else if (id.substr(0, 1) === "-" || // escape previously dashed strings
               id.substr(0, 1) === "~" || // escape escaped numbers, true, false
               LocalCollection._looksLikeObjectID(id) || // escape object-id-form strings
               id.substr(0, 1) === '{') { // escape object-form strings, for maybe implementing later
      return "-" + id;
    } else {
      return id; // other strings go through unchanged.
    }
  } else if (id === undefined) {
    return '-';
  } else if (typeof id === 'object' && id !== null) {
    throw new Error("Meteor does not currently support objects other than ObjectID as ids");
  } else { // Numbers, true, false, null
    return "~" + JSON.stringify(id);
  }
};


// NB: used by livedata
LocalCollection._idParse = function (id) {
  if (id === "") {
    return id;
  } else if (id === '-') {
    return undefined;
  } else if (id.substr(0, 1) === '-') {
    return id.substr(1);
  } else if (id.substr(0, 1) === '~') {
    return JSON.parse(id.substr(1));
  } else if (LocalCollection._looksLikeObjectID(id)) {
    return new LocalCollection._ObjectID(id);
  } else {
    return id;
  }
};

LocalCollection._makeChangedFields = function (newDoc, oldDoc) {
  var fields = {};
  LocalCollection._diffObjects(oldDoc, newDoc, {
    leftOnly: function (key, value) {
      fields[key] = undefined;
    },
    rightOnly: function (key, value) {
      fields[key] = value;
    },
    both: function (key, leftValue, rightValue) {
      if (!EJSON.equals(leftValue, rightValue))
        fields[key] = rightValue;
    }
  });
  return fields;
};

// Wrap a transform function to return objects that have the _id field
// of the untransformed document. This ensures that subsystems such as
// the observe-sequence package that call `observe` can keep track of
// the documents identities.
//
// - Require that it returns objects
// - If the return value has an _id field, verify that it matches the
//   original _id field
// - If the return value doesn't have an _id field, add it back.
LocalCollection.wrapTransform = function (transform) {
  if (!transform)
    return null;

  return function (doc) {
    if (!_.has(doc, '_id')) {
      // XXX do we ever have a transform on the oplog's collection? because that
      // collection has no _id.
      throw new Error("can only transform documents with _id");
    }

    var id = doc._id;
    // XXX consider making deps a weak dependency and checking Package.deps here
    var transformed = Deps.nonreactive(function () {
      return transform(doc);
    });

    if (!isPlainObject(transformed)) {
      throw new Error("transform must return object");
    }

    if (_.has(transformed, '_id')) {
      if (!EJSON.equals(transformed._id, id)) {
        throw new Error("transformed document can't have different _id");
      }
    } else {
      transformed._id = id;
    }
    return transformed;
  };
};

// Like _.isArray, but doesn't regard polyfilled Uint8Arrays on old browsers as
// arrays.
// XXX maybe this should be EJSON.isArray
isArray = function (x) {
  return _.isArray(x) && !EJSON.isBinary(x);
};

// XXX maybe this should be EJSON.isObject, though EJSON doesn't know about
// RegExp
// XXX note that _type(undefined) === 3!!!!
isPlainObject = function (x) {
  return x && LocalCollection._f._type(x) === 3;
};

isIndexable = function (x) {
  return isArray(x) || isPlainObject(x);
};

isOperatorObject = function (valueSelector) {
  if (!isPlainObject(valueSelector))
    return false;

  var theseAreOperators = undefined;
  _.each(valueSelector, function (value, selKey) {
    var thisIsOperator = selKey.substr(0, 1) === '$';
    if (theseAreOperators === undefined) {
      theseAreOperators = thisIsOperator;
    } else if (theseAreOperators !== thisIsOperator) {
      throw new Error("Inconsistent operator: " + valueSelector);
    }
  });
  return !!theseAreOperators;  // {} has no operators
};


// string can be converted to integer
isNumericKey = function (s) {
  return /^[0-9]+$/.test(s);
};


// Give a sort spec, which can be in any of these forms:
//   {"key1": 1, "key2": -1}
//   [["key1", "asc"], ["key2", "desc"]]
//   ["key1", ["key2", "desc"]]
//
// (.. with the first form being dependent on the key enumeration
// behavior of your javascript VM, which usually does what you mean in
// this case if the key names don't look like integers ..)
//
// return a function that takes two objects, and returns -1 if the
// first object comes first in order, 1 if the second object comes
// first, or 0 if neither object comes before the other.

Sorter = function (spec) {
  var self = this;

  var sortSpecParts = [];

  if (spec instanceof Array) {
    for (var i = 0; i < spec.length; i++) {
      if (typeof spec[i] === "string") {
        sortSpecParts.push({
          lookup: makeLookupFunction(spec[i]),
          ascending: true
        });
      } else {
        sortSpecParts.push({
          lookup: makeLookupFunction(spec[i][0]),
          ascending: spec[i][1] !== "desc"
        });
      }
    }
  } else if (typeof spec === "object") {
    for (var key in spec) {
      sortSpecParts.push({
        lookup: makeLookupFunction(key),
        ascending: spec[key] >= 0
      });
    }
  } else {
    throw Error("Bad sort specification: ", JSON.stringify(spec));
  }

  // reduceValue takes in all the possible values for the sort key along various
  // branches, and returns the min or max value (according to the bool
  // findMin). Each value can itself be an array, and we look at its values
  // too. (ie, we do a single level of flattening on branchValues, then find the
  // min/max.)
  //
  // XXX This is actually wrong! In fact, the whole attempt to compile sort
  //     functions independently of selectors is wrong. In MongoDB, if you have
  //     documents {_id: 'x', a: [1, 10]} and {_id: 'y', a: [5, 15]}, then
  //     C.find({}, {sort: {a: 1}}) puts x before y (1 comes before 5).  But
  //     C.find({a: {$gt: 3}}, {sort: {a: 1}}) puts y before x (1 does not match
  //     the selector, and 5 comes before 10).
  //
  //     The way this works is pretty subtle!  For example, if the documents are
  //     instead {_id: 'x', a: [{x: 1}, {x: 10}]}) and
  //             {_id: 'y', a: [{x: 5}, {x: 15}]}),
  //     then C.find({'a.x': {$gt: 3}}, {sort: {'a.x': 1}}) and
  //          C.find({a: {$elemMatch: {x: {$gt: 3}}}}, {sort: {'a.x': 1}})
  //     both follow this rule (y before x).  ie, you do have to apply this
  //     through $elemMatch.
  var reduceValue = function (branchValues, findMin) {
    // Expand any leaf arrays that we find, and ignore those arrays themselves.
    branchValues = expandArraysInBranches(branchValues, true);
    var reduced = undefined;
    var first = true;
    // Iterate over all the values found in all the branches, and if a value is
    // an array itself, iterate over the values in the array separately.
    _.each(branchValues, function (branchValue) {
      if (first) {
        reduced = branchValue.value;
        first = false;
      } else {
        // Compare the value we found to the value we found so far, saving it
        // if it's less (for an ascending sort) or more (for a descending
        // sort).
        var cmp = LocalCollection._f._cmp(reduced, branchValue.value);
        if ((findMin && cmp > 0) || (!findMin && cmp < 0))
          reduced = branchValue.value;
      }
    });
    return reduced;
  };

  var comparators = _.map(sortSpecParts, function (specPart) {
    return function (a, b) {
      var aValue = reduceValue(specPart.lookup(a), specPart.ascending);
      var bValue = reduceValue(specPart.lookup(b), specPart.ascending);
      var compare = LocalCollection._f._cmp(aValue, bValue);
      return specPart.ascending ? compare : -compare;
    };
  });

  self._baseComparator = composeComparators(comparators);
};

Sorter.prototype.getComparator = function (options) {
  var self = this;

  // If we have no distances, just use the comparator from the source
  // specification (which defaults to "everything is equal".
  if (!options || !options.distances) {
    return self._baseComparator;
  }

  var distances = options.distances;

  // Return a comparator which first tries the sort specification, and if that
  // says "it's equal", breaks ties using $near distances.
  return composeComparators([self._baseComparator, function (a, b) {
    if (!distances.has(a._id))
      throw Error("Missing distance for " + a._id);
    if (!distances.has(b._id))
      throw Error("Missing distance for " + b._id);
    return distances.get(a._id) - distances.get(b._id);
  }]);
};

MinimongoTest.Sorter = Sorter;

// Given an array of comparators
// (functions (a,b)->(negative or positive or zero)), returns a single
// comparator which uses each comparator in order and returns the first
// non-zero value.
var composeComparators = function (comparatorArray) {
  return function (a, b) {
    for (var i = 0; i < comparatorArray.length; ++i) {
      var compare = comparatorArray[i](a, b);
      if (compare !== 0)
        return compare;
    }
    return 0;
  };
};


// The minimongo selector compiler!

// Terminology:
//  - a "selector" is the EJSON object representing a selector
//  - a "matcher" is its compiled form (whether a full Minimongo.Matcher
//    object or one of the component lambdas that matches parts of it)
//  - a "result object" is an object with a "result" field and maybe
//    distance and arrayIndex.
//  - a "branched value" is an object with a "value" field and maybe
//    "dontIterate" and "arrayIndex".
//  - a "document" is a top-level object that can be stored in a collection.
//  - a "lookup function" is a function that takes in a document and returns
//    an array of "branched values".
//  - a "branched matcher" maps from an array of branched values to a result
//    object.
//  - an "element matcher" maps from a single value to a bool.

// Main entry point.
//   var matcher = new Minimongo.Matcher({a: {$gt: 5}});
//   if (matcher.documentMatches({a: 7})) ...
Minimongo.Matcher = function (selector) {
  var self = this;
  // A set (object mapping string -> *) of all of the document paths looked
  // at by the selector. Also includes the empty string if it may look at any
  // path (eg, $where).
  self._paths = {};
  // Set to true if compilation finds a $near.
  self._hasGeoQuery = false;
  // Set to true if compilation finds a $where.
  self._hasWhere = false;
  // Set to false if compilation finds anything other than a simple equality or
  // one or more of '$gt', '$gte', '$lt', '$lte', '$ne', '$in', '$nin' used with
  // scalars as operands.
  self._isSimple = true;
  // Set to a dummy document which always matches this Matcher. Or set to null
  // if such document is too hard to find.
  self._matchingDocument = undefined;
  // A clone of the original selector. Used by canBecomeTrueByModifier.
  self._selector = null;
  self._docMatcher = self._compileSelector(selector);
};

_.extend(Minimongo.Matcher.prototype, {
  documentMatches: function (doc) {
    return this._docMatcher(doc);
  },
  hasGeoQuery: function () {
    return this._hasGeoQuery;
  },
  hasWhere: function () {
    return this._hasWhere;
  },
  isSimple: function () {
    return this._isSimple;
  },

  // Given a selector, return a function that takes one argument, a
  // document. It returns a result object.
  _compileSelector: function (selector) {
    var self = this;
    // you can pass a literal function instead of a selector
    if (selector instanceof Function) {
      self._isSimple = false;
      self._selector = selector;
      self._recordPathUsed('');
      return function (doc) {
        return {result: !!selector.call(doc)};
      };
    }

    // shorthand -- scalars match _id
    if (LocalCollection._selectorIsId(selector)) {
      self._selector = {_id: selector};
      self._recordPathUsed('_id');
      return function (doc) {
        return {result: EJSON.equals(doc._id, selector)};
      };
    }

    // protect against dangerous selectors.  falsey and {_id: falsey} are both
    // likely programmer error, and not what you want, particularly for
    // destructive operations.
    if (!selector || (('_id' in selector) && !selector._id)) {
      self._isSimple = false;
      return nothingMatcher;
    }

    // Top level can't be an array or true or binary.
    if (typeof(selector) === 'boolean' || isArray(selector) ||
        EJSON.isBinary(selector))
      throw new Error("Invalid selector: " + selector);

    self._selector = EJSON.clone(selector);
    return compileDocumentSelector(selector, self, {isRoot: true});
  },
  _recordPathUsed: function (path) {
    this._paths[path] = true;
  },
  // Returns a list of key paths the given selector is looking for. It includes
  // the empty string if there is a $where.
  _getPaths: function () {
    return _.keys(this._paths);
  }
});


// Takes in a selector that could match a full document (eg, the original
// selector). Returns a function mapping document->result object.
//
// matcher is the Matcher object we are compiling.
//
// If this is the root document selector (ie, not wrapped in $and or the like),
// then isRoot is true. (This is used by $near.)
var compileDocumentSelector = function (docSelector, matcher, options) {
  options = options || {};
  var docMatchers = [];
  _.each(docSelector, function (subSelector, key) {
    if (key.substr(0, 1) === '$') {
      // Outer operators are either logical operators (they recurse back into
      // this function), or $where.
      if (!_.has(LOGICAL_OPERATORS, key))
        throw new Error("Unrecognized logical operator: " + key);
      matcher._isSimple = false;
      docMatchers.push(LOGICAL_OPERATORS[key](subSelector, matcher,
                                              options.inElemMatch));
    } else {
      // Record this path, but only if we aren't in an elemMatcher, since in an
      // elemMatch this is a path inside an object in an array, not in the doc
      // root.
      if (!options.inElemMatch)
        matcher._recordPathUsed(key);
      var lookUpByIndex = makeLookupFunction(key);
      var valueMatcher =
        compileValueSelector(subSelector, matcher, options.isRoot);
      docMatchers.push(function (doc) {
        var branchValues = lookUpByIndex(doc);
        return valueMatcher(branchValues);
      });
    }
  });

  return andDocumentMatchers(docMatchers);
};

// Takes in a selector that could match a key-indexed value in a document; eg,
// {$gt: 5, $lt: 9}, or a regular expression, or any non-expression object (to
// indicate equality).  Returns a branched matcher: a function mapping
// [branched value]->result object.
var compileValueSelector = function (valueSelector, matcher, isRoot) {
  if (valueSelector instanceof RegExp) {
    matcher._isSimple = false;
    return convertElementMatcherToBranchedMatcher(
      regexpElementMatcher(valueSelector));
  } else if (isOperatorObject(valueSelector)) {
    return operatorBranchedMatcher(valueSelector, matcher, isRoot);
  } else {
    return convertElementMatcherToBranchedMatcher(
      equalityElementMatcher(valueSelector));
  }
};

// Given an element matcher (which evaluates a single value), returns a branched
// value (which evaluates the element matcher on all the branches and returns a
// more structured return value possibly including arrayIndex).
var convertElementMatcherToBranchedMatcher = function (
    elementMatcher, options) {
  options = options || {};
  return function (branches) {
    var expanded = branches;
    if (!options.dontExpandLeafArrays) {
      expanded = expandArraysInBranches(
        branches, options.dontIncludeLeafArrays);
    }
    var ret = {};
    ret.result = _.any(expanded, function (element) {
      var matched = elementMatcher(element.value);

      // Special case for $elemMatch: it means "true, and use this arrayIndex if
      // I didn't already have one".
      if (typeof matched === 'number') {
        if (element.arrayIndex === undefined)
          element.arrayIndex = matched;
        matched = true;
      }

      // If some element matched, and it's tagged with an array index, include
      // that index in our result object.
      if (matched && element.arrayIndex !== undefined)
        ret.arrayIndex = element.arrayIndex;

      return matched;
    });
    return ret;
  };
};

// Takes a RegExp object and returns an element matcher.
var regexpElementMatcher = function (regexp) {
  return function (value) {
    if (value instanceof RegExp) {
      // Comparing two regexps means seeing if the regexps are identical
      // (really!). Underscore knows how.
      return _.isEqual(value, regexp);
    }
    // Regexps only work against strings.
    if (typeof value !== 'string')
      return false;
    return regexp.test(value);
  };
};

// Takes something that is not an operator object and returns an element matcher
// for equality with that thing.
var equalityElementMatcher = function (elementSelector) {
  if (isOperatorObject(elementSelector))
    throw Error("Can't create equalityValueSelector for operator object");

  // Special-case: null and undefined are equal (if you got undefined in there
  // somewhere, or if you got it due to some branch being non-existent in the
  // weird special case), even though they aren't with EJSON.equals.
  if (elementSelector == null) {  // undefined or null
    return function (value) {
      return value == null;  // undefined or null
    };
  }

  return function (value) {
    return LocalCollection._f._equal(elementSelector, value);
  };
};

// Takes an operator object (an object with $ keys) and returns a branched
// matcher for it.
var operatorBranchedMatcher = function (valueSelector, matcher, isRoot) {
  // Each valueSelector works separately on the various branches.  So one
  // operator can match one branch and another can match another branch.  This
  // is OK.

  var operatorMatchers = [];
  _.each(valueSelector, function (operand, operator) {
    // XXX we should actually implement $eq, which is new in 2.6
    var simpleRange = _.contains(['$lt', '$lte', '$gt', '$gte'], operator) &&
      _.isNumber(operand);
    var simpleInequality = operator === '$ne' && !_.isObject(operand);
    var simpleInclusion = _.contains(['$in', '$nin'], operator) &&
      _.isArray(operand) && !_.any(operand, _.isObject);

    if (! (operator === '$eq' || simpleRange ||
           simpleInclusion || simpleInequality)) {
      matcher._isSimple = false;
    }

    if (_.has(VALUE_OPERATORS, operator)) {
      operatorMatchers.push(
        VALUE_OPERATORS[operator](operand, valueSelector, matcher, isRoot));
    } else if (_.has(ELEMENT_OPERATORS, operator)) {
      var options = ELEMENT_OPERATORS[operator];
      if (typeof options === 'function')
        options = {compileElementSelector: options};
      operatorMatchers.push(
        convertElementMatcherToBranchedMatcher(
          options.compileElementSelector(
            operand, valueSelector, matcher),
          options));
    } else {
      throw new Error("Unrecognized operator: " + operator);
    }
  });

  return andBranchedMatchers(operatorMatchers);
};

var compileArrayOfDocumentSelectors = function (
    selectors, matcher, inElemMatch) {
  if (!isArray(selectors) || _.isEmpty(selectors))
    throw Error("$and/$or/$nor must be nonempty array");
  return _.map(selectors, function (subSelector) {
    if (!isPlainObject(subSelector))
      throw Error("$or/$and/$nor entries need to be full objects");
    return compileDocumentSelector(
      subSelector, matcher, {inElemMatch: inElemMatch});
  });
};

// Operators that appear at the top level of a document selector.
var LOGICAL_OPERATORS = {
  $and: function (subSelector, matcher, inElemMatch) {
    var matchers = compileArrayOfDocumentSelectors(
      subSelector, matcher, inElemMatch);
    return andDocumentMatchers(matchers);
  },

  $or: function (subSelector, matcher, inElemMatch) {
    var matchers = compileArrayOfDocumentSelectors(
      subSelector, matcher, inElemMatch);

    // Special case: if there is only one matcher, use it directly, *preserving*
    // any arrayIndex it returns.
    if (matchers.length === 1)
      return matchers[0];

    return function (doc) {
      var result = _.any(matchers, function (f) {
        return f(doc).result;
      });
      // $or does NOT set arrayIndex when it has multiple
      // sub-expressions. (Tested against MongoDB.)
      return {result: result};
    };
  },

  $nor: function (subSelector, matcher, inElemMatch) {
    var matchers = compileArrayOfDocumentSelectors(
      subSelector, matcher, inElemMatch);
    return function (doc) {
      var result = _.all(matchers, function (f) {
        return !f(doc).result;
      });
      // Never set arrayIndex, because we only match if nothing in particular
      // "matched" (and because this is consistent with MongoDB).
      return {result: result};
    };
  },

  $where: function (selectorValue, matcher) {
    // Record that *any* path may be used.
    matcher._recordPathUsed('');
    matcher._hasWhere = true;
    if (!(selectorValue instanceof Function)) {
      // XXX MongoDB seems to have more complex logic to decide where or or not
      // to add "return"; not sure exactly what it is.
      selectorValue = Function("obj", "return " + selectorValue);
    }
    return function (doc) {
      // We make the document available as both `this` and `obj`.
      // XXX not sure what we should do if this throws
      return {result: selectorValue.call(doc, doc)};
    };
  },

  // This is just used as a comment in the query (in MongoDB, it also ends up in
  // query logs); it has no effect on the actual selection.
  $comment: function () {
    return function () {
      return {result: true};
    };
  }
};

// Returns a branched matcher that matches iff the given matcher does not.
// Note that this implicitly "deMorganizes" the wrapped function.  ie, it
// means that ALL branch values need to fail to match innerBranchedMatcher.
var invertBranchedMatcher = function (branchedMatcher) {
  return function (branchValues) {
    var invertMe = branchedMatcher(branchValues);
    // We explicitly choose to strip arrayIndex here: it doesn't make sense to
    // say "update the array element that does not match something", at least
    // in mongo-land.
    return {result: !invertMe.result};
  };
};

// Operators that (unlike LOGICAL_OPERATORS) pertain to individual paths in a
// document, but (unlike ELEMENT_OPERATORS) do not have a simple definition as
// "match each branched value independently and combine with
// convertElementMatcherToBranchedMatcher".
var VALUE_OPERATORS = {
  $not: function (operand, valueSelector, matcher) {
    return invertBranchedMatcher(compileValueSelector(operand, matcher));
  },
  $ne: function (operand) {
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(
      equalityElementMatcher(operand)));
  },
  $nin: function (operand) {
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(
      ELEMENT_OPERATORS.$in(operand)));
  },
  $exists: function (operand) {
    var exists = convertElementMatcherToBranchedMatcher(function (value) {
      return value !== undefined;
    });
    return operand ? exists : invertBranchedMatcher(exists);
  },
  // $options just provides options for $regex; its logic is inside $regex
  $options: function (operand, valueSelector) {
    if (!valueSelector.$regex)
      throw Error("$options needs a $regex");
    return everythingMatcher;
  },
  // $maxDistance is basically an argument to $near
  $maxDistance: function (operand, valueSelector) {
    if (!valueSelector.$near)
      throw Error("$maxDistance needs a $near");
    return everythingMatcher;
  },
  $all: function (operand, valueSelector, matcher) {
    if (!isArray(operand))
      throw Error("$all requires array");
    // Not sure why, but this seems to be what MongoDB does.
    if (_.isEmpty(operand))
      return nothingMatcher;

    var branchedMatchers = [];
    _.each(operand, function (criterion) {
      // XXX handle $all/$elemMatch combination
      if (isOperatorObject(criterion))
        throw Error("no $ expressions in $all");
      // This is always a regexp or equality selector.
      branchedMatchers.push(compileValueSelector(criterion, matcher));
    });
    // andBranchedMatchers does NOT require all selectors to return true on the
    // SAME branch.
    return andBranchedMatchers(branchedMatchers);
  },
  $near: function (operand, valueSelector, matcher, isRoot) {
    if (!isRoot)
      throw Error("$near can't be inside another $ operator");
    matcher._hasGeoQuery = true;

    // There are two kinds of geodata in MongoDB: coordinate pairs and
    // GeoJSON. They use different distance metrics, too. GeoJSON queries are
    // marked with a $geometry property.

    var maxDistance, point, distance;
    if (isPlainObject(operand) && _.has(operand, '$geometry')) {
      // GeoJSON "2dsphere" mode.
      maxDistance = operand.$maxDistance;
      point = operand.$geometry;
      distance = function (value) {
        // XXX: for now, we don't calculate the actual distance between, say,
        // polygon and circle. If people care about this use-case it will get
        // a priority.
        if (!value || !value.type)
          return null;
        if (value.type === "Point") {
          return GeoJSON.pointDistance(point, value);
        } else {
          return GeoJSON.geometryWithinRadius(value, point, maxDistance)
            ? 0 : maxDistance + 1;
        }
      };
    } else {
      maxDistance = valueSelector.$maxDistance;
      if (!isArray(operand) && !isPlainObject(operand))
        throw Error("$near argument must be coordinate pair or GeoJSON");
      point = pointToArray(operand);
      distance = function (value) {
        if (!isArray(value) && !isPlainObject(value))
          return null;
        return distanceCoordinatePairs(point, value);
      };
    }

    return function (branchedValues) {
      // There might be multiple points in the document that match the given
      // field. Only one of them needs to be within $maxDistance, but we need to
      // evaluate all of them and use the nearest one for the implicit sort
      // specifier. (That's why we can't just use ELEMENT_OPERATORS here.)
      //
      // Note: This differs from MongoDB's implementation, where a document will
      // actually show up *multiple times* in the result set, with one entry for
      // each within-$maxDistance branching point.
      branchedValues = expandArraysInBranches(branchedValues);
      var result = {result: false};
      _.each(branchedValues, function (branch) {
        var curDistance = distance(branch.value);
        // Skip branches that aren't real points or are too far away.
        if (curDistance === null || curDistance > maxDistance)
          return;
        // Skip anything that's a tie.
        if (result.distance !== undefined && result.distance <= curDistance)
          return;
        result.result = true;
        result.distance = curDistance;
        if (branch.arrayIndex === undefined)
          delete result.arrayIndex;
        else
          result.arrayIndex = branch.arrayIndex;
      });
      return result;
    };
  }
};

// Helpers for $near.
var distanceCoordinatePairs = function (a, b) {
  a = pointToArray(a);
  b = pointToArray(b);
  var x = a[0] - b[0];
  var y = a[1] - b[1];
  if (_.isNaN(x) || _.isNaN(y))
    return null;
  return Math.sqrt(x * x + y * y);
};
// Makes sure we get 2 elements array and assume the first one to be x and
// the second one to y no matter what user passes.
// In case user passes { lon: x, lat: y } returns [x, y]
var pointToArray = function (point) {
  return _.map(point, _.identity);
};

// Helper for $lt/$gt/$lte/$gte.
var makeInequality = function (cmpValueComparator) {
  return function (operand) {
    // Arrays never compare false with non-arrays for any inequality.
    if (isArray(operand)) {
      return function () {
        return false;
      };
    }

    // Special case: consider undefined and null the same (so true with
    // $gte/$lte).
    if (operand === undefined)
      operand = null;

    var operandType = LocalCollection._f._type(operand);

    return function (value) {
      if (value === undefined)
        value = null;
      // Comparisons are never true among things of different type (except null
      // vs undefined).
      if (LocalCollection._f._type(value) !== operandType)
        return false;
      return cmpValueComparator(LocalCollection._f._cmp(value, operand));
    };
  };
};

// Each element selector is a function with args:
//  - operand - the "right hand side" of the operator
//  - valueSelector - the "context" for the operator (so that $regex can find
//    $options)
// Or is an object with an compileElementSelector field (the above) and optional
// flags dontExpandLeafArrays and dontIncludeLeafArrays which control if
// expandArraysInBranches is called and if it takes an optional argument.
//
// An element selector compiler returns a function mapping a single value to
// bool.
var ELEMENT_OPERATORS = {
  $lt: makeInequality(function (cmpValue) {
    return cmpValue < 0;
  }),
  $gt: makeInequality(function (cmpValue) {
    return cmpValue > 0;
  }),
  $lte: makeInequality(function (cmpValue) {
    return cmpValue <= 0;
  }),
  $gte: makeInequality(function (cmpValue) {
    return cmpValue >= 0;
  }),
  $mod: function (operand) {
    if (!(isArray(operand) && operand.length === 2
          && typeof(operand[0]) === 'number'
          && typeof(operand[1]) === 'number')) {
      throw Error("argument to $mod must be an array of two numbers");
    }
    // XXX could require to be ints or round or something
    var divisor = operand[0];
    var remainder = operand[1];
    return function (value) {
      return typeof value === 'number' && value % divisor === remainder;
    };
  },
  $in: function (operand) {
    if (!isArray(operand))
      throw Error("$in needs an array");

    var elementMatchers = [];
    _.each(operand, function (option) {
      if (option instanceof RegExp)
        elementMatchers.push(regexpElementMatcher(option));
      else if (isOperatorObject(option))
        throw Error("cannot nest $ under $in");
      else
        elementMatchers.push(equalityElementMatcher(option));
    });

    return function (value) {
      // Allow {a: {$in: [null]}} to match when 'a' does not exist.
      if (value === undefined)
        value = null;
      return _.any(elementMatchers, function (e) {
        return e(value);
      });
    };
  },
  $size: {
    // {a: [[5, 5]]} must match {a: {$size: 1}} but not {a: {$size: 2}}, so we
    // don't want to consider the element [5,5] in the leaf array [[5,5]] as a
    // possible value.
    dontExpandLeafArrays: true,
    compileElementSelector: function (operand) {
      if (typeof operand === 'string') {
        // Don't ask me why, but by experimentation, this seems to be what Mongo
        // does.
        operand = 0;
      } else if (typeof operand !== 'number') {
        throw Error("$size needs a number");
      }
      return function (value) {
        return isArray(value) && value.length === operand;
      };
    }
  },
  $type: {
    // {a: [5]} must not match {a: {$type: 4}} (4 means array), but it should
    // match {a: {$type: 1}} (1 means number), and {a: [[5]]} must match {$a:
    // {$type: 4}}. Thus, when we see a leaf array, we *should* expand it but
    // should *not* include it itself.
    dontIncludeLeafArrays: true,
    compileElementSelector: function (operand) {
      if (typeof operand !== 'number')
        throw Error("$type needs a number");
      return function (value) {
        return value !== undefined
          && LocalCollection._f._type(value) === operand;
      };
    }
  },
  $regex: function (operand, valueSelector) {
    if (!(typeof operand === 'string' || operand instanceof RegExp))
      throw Error("$regex has to be a string or RegExp");

    var regexp;
    if (valueSelector.$options !== undefined) {
      // Options passed in $options (even the empty string) always overrides
      // options in the RegExp object itself. (See also
      // Meteor.Collection._rewriteSelector.)

      // Be clear that we only support the JS-supported options, not extended
      // ones (eg, Mongo supports x and s). Ideally we would implement x and s
      // by transforming the regexp, but not today...
      if (/[^gim]/.test(valueSelector.$options))
        throw new Error("Only the i, m, and g regexp options are supported");

      var regexSource = operand instanceof RegExp ? operand.source : operand;
      regexp = new RegExp(regexSource, valueSelector.$options);
    } else if (operand instanceof RegExp) {
      regexp = operand;
    } else {
      regexp = new RegExp(operand);
    }
    return regexpElementMatcher(regexp);
  },
  $elemMatch: {
    dontExpandLeafArrays: true,
    compileElementSelector: function (operand, valueSelector, matcher) {
      if (!isPlainObject(operand))
        throw Error("$elemMatch need an object");

      var subMatcher, isDocMatcher;
      if (isOperatorObject(operand)) {
        subMatcher = compileValueSelector(operand, matcher);
        isDocMatcher = false;
      } else {
        // This is NOT the same as compileValueSelector(operand), and not just
        // because of the slightly different calling convention.
        // {$elemMatch: {x: 3}} means "an element has a field x:3", not
        // "consists only of a field x:3". Also, regexps and sub-$ are allowed.
        subMatcher = compileDocumentSelector(operand, matcher,
                                             {inElemMatch: true});
        isDocMatcher = true;
      }

      return function (value) {
        if (!isArray(value))
          return false;
        for (var i = 0; i < value.length; ++i) {
          var arrayElement = value[i];
          var arg;
          if (isDocMatcher) {
            // We can only match {$elemMatch: {b: 3}} against objects.
            // (We can also match against arrays, if there's numeric indices,
            // eg {$elemMatch: {'0.b': 3}} or {$elemMatch: {0: 3}}.)
            if (!isPlainObject(arrayElement) && !isArray(arrayElement))
              return false;
            arg = arrayElement;
          } else {
            // dontIterate ensures that {a: {$elemMatch: {$gt: 5}}} matches
            // {a: [8]} but not {a: [[8]]}
            arg = [{value: arrayElement, dontIterate: true}];
          }
          // XXX support $near in $elemMatch by propagating $distance?
          if (subMatcher(arg).result)
            return i;   // specially understood to mean "use my arrayIndex"
        }
        return false;
      };
    }
  }
};

// makeLookupFunction(key) returns a lookup function.
//
// A lookup function takes in a document and returns an array of matching
// branches.  If no arrays are found while looking up the key, this array will
// have exactly one branches (possibly 'undefined', if some segment of the key
// was not found).
//
// If arrays are found in the middle, this can have more than one element, since
// we "branch". When we "branch", if there are more key segments to look up,
// then we only pursue branches that are plain objects (not arrays or scalars).
// This means we can actually end up with no branches!
//
// We do *NOT* branch on arrays that are found at the end (ie, at the last
// dotted member of the key). We just return that array; if you want to
// effectively "branch" over the array's values, post-process the lookup
// function with expandArraysInBranches.
//
// Each branch is an object with keys:
//  - value: the value at the branch
//  - dontIterate: an optional bool; if true, it means that 'value' is an array
//    that expandArraysInBranches should NOT expand. This specifically happens
//    when there is a numeric index in the key, and ensures the
//    perhaps-surprising MongoDB behavior where {'a.0': 5} does NOT
//    match {a: [[5]]}.
//  - arrayIndex: if any array indexing was done during lookup (either
//    due to explicit numeric indices or implicit branching), this will
//    be the FIRST (outermost) array index used; it is undefined or absent
//    if no array index is used. (Make sure to check its value vs undefined,
//    not just for truth, since '0' is a legit array index!) This is used
//    to implement the '$' modifier feature.
//
// At the top level, you may only pass in a plain object or arraym.
//
// See the text 'minimongo - lookup' for some examples of what lookup functions
// return.
makeLookupFunction = function (key) {
  var parts = key.split('.');
  var firstPart = parts.length ? parts[0] : '';
  var firstPartIsNumeric = isNumericKey(firstPart);
  var lookupRest;
  if (parts.length > 1) {
    lookupRest = makeLookupFunction(parts.slice(1).join('.'));
  }

  var elideUnnecessaryFields = function (retVal) {
    if (!retVal.dontIterate)
      delete retVal.dontIterate;
    if (retVal.arrayIndex === undefined)
      delete retVal.arrayIndex;
    return retVal;
  };

  // Doc will always be a plain object or an array.
  // apply an explicit numeric index, an array.
  return function (doc, firstArrayIndex) {
    if (isArray(doc)) {
      // If we're being asked to do an invalid lookup into an array (non-integer
      // or out-of-bounds), return no results (which is different from returning
      // a single undefined result, in that `null` equality checks won't match).
      if (!(firstPartIsNumeric && firstPart < doc.length))
        return [];

      // If this is the first array index we've seen, remember the index.
      // (Mongo doesn't support multiple uses of '$', at least not in 2.5.
      if (firstArrayIndex === undefined)
        firstArrayIndex = +firstPart;
    }

    // Do our first lookup.
    var firstLevel = doc[firstPart];

    // If there is no deeper to dig, return what we found.
    //
    // If what we found is an array, most value selectors will choose to treat
    // the elements of the array as matchable values in their own right, but
    // that's done outside of the lookup function. (Exceptions to this are $size
    // and stuff relating to $elemMatch.  eg, {a: {$size: 2}} does not match {a:
    // [[1, 2]]}.)
    //
    // That said, if we just did an *explicit* array lookup (on doc) to find
    // firstLevel, and firstLevel is an array too, we do NOT want value
    // selectors to iterate over it.  eg, {'a.0': 5} does not match {a: [[5]]}.
    // So in that case, we mark the return value as "don't iterate".
    if (!lookupRest) {
      return [elideUnnecessaryFields({
        value: firstLevel,
        dontIterate: isArray(doc) && isArray(firstLevel),
        arrayIndex: firstArrayIndex})];
    }

    // We need to dig deeper.  But if we can't, because what we've found is not
    // an array or plain object, we're done. If we just did a numeric index into
    // an array, we return nothing here (this is a change in Mongo 2.5 from
    // Mongo 2.4, where {'a.0.b': null} stopped matching {a: [5]}). Otherwise,
    // return a single `undefined` (which can, for example, match via equality
    // with `null`).
    if (!isIndexable(firstLevel)) {
      if (isArray(doc))
        return [];
      return [elideUnnecessaryFields({value: undefined,
                                      arrayIndex: firstArrayIndex})];
    }

    var result = [];
    var appendToResult = function (more) {
      Array.prototype.push.apply(result, more);
    };

    // Dig deeper: look up the rest of the parts on whatever we've found.
    // (lookupRest is smart enough to not try to do invalid lookups into
    // firstLevel if it's an array.)
    appendToResult(lookupRest(firstLevel, firstArrayIndex));

    // If we found an array, then in *addition* to potentially treating the next
    // part as a literal integer lookup, we should also "branch": try to do look
    // up the rest of the parts on each array element in parallel.
    //
    // In this case, we *only* dig deeper into array elements that are plain
    // objects. (Recall that we only got this far if we have further to dig.)
    // This makes sense: we certainly don't dig deeper into non-indexable
    // objects. And it would be weird to dig into an array: it's simpler to have
    // a rule that explicit integer indexes only apply to an outer array, not to
    // an array you find after a branching search.
    if (isArray(firstLevel)) {
      _.each(firstLevel, function (branch, arrayIndex) {
        if (isPlainObject(branch)) {
          appendToResult(lookupRest(
            branch,
            firstArrayIndex === undefined ? arrayIndex : firstArrayIndex));
        }
      });
    }

    return result;
  };
};
MinimongoTest.makeLookupFunction = makeLookupFunction;

expandArraysInBranches = function (branches, skipTheArrays) {
  var branchesOut = [];
  _.each(branches, function (branch) {
    var thisIsArray = isArray(branch.value);
    // We include the branch itself, *UNLESS* we it's an array that we're going
    // to iterate and we're told to skip arrays.  (That's right, we include some
    // arrays even skipTheArrays is true: these are arrays that were found via
    // explicit numerical indices.)
    if (!(skipTheArrays && thisIsArray && !branch.dontIterate)) {
      branchesOut.push({
        value: branch.value,
        arrayIndex: branch.arrayIndex
      });
    }
    if (thisIsArray && !branch.dontIterate) {
      _.each(branch.value, function (leaf, i) {
        branchesOut.push({
          value: leaf,
          // arrayIndex always defaults to the outermost array, but if we didn't
          // need to use an array to get to this branch, we mark the index we
          // just used as the arrayIndex.
          arrayIndex: branch.arrayIndex === undefined ? i : branch.arrayIndex
        });
      });
    }
  });
  return branchesOut;
};

var nothingMatcher = function (docOrBranchedValues) {
  return {result: false};
};

var everythingMatcher = function (docOrBranchedValues) {
  return {result: true};
};


// NB: We are cheating and using this function to implement "AND" for both
// "document matchers" and "branched matchers". They both return result objects
// but the argument is different: for the former it's a whole doc, whereas for
// the latter it's an array of "branched values".
var andSomeMatchers = function (subMatchers) {
  if (subMatchers.length === 0)
    return everythingMatcher;
  if (subMatchers.length === 1)
    return subMatchers[0];

  return function (docOrBranches) {
    // XXX arrayIndex!
    var ret = {};
    ret.result = _.all(subMatchers, function (f) {
      var subResult = f(docOrBranches);
      // Copy a 'distance' number out of the first sub-matcher that has
      // one. Yes, this means that if there are multiple $near fields in a
      // query, something arbitrary happens; this appears to be consistent with
      // Mongo.
      if (subResult.result && subResult.distance !== undefined
          && ret.distance === undefined) {
        ret.distance = subResult.distance;
      }
      // Similarly, propagate arrayIndex from sub-matchers... but to match
      // MongoDB behavior, this time the *last* sub-matcher with an arrayIndex
      // wins.
      if (subResult.result && subResult.arrayIndex !== undefined) {
        ret.arrayIndex = subResult.arrayIndex;
      }
      return subResult.result;
    });

    // If we didn't actually match, forget any extra metadata we came up with.
    if (!ret.result) {
      delete ret.distance;
      delete ret.arrayIndex;
    }
    return ret;
  };
};

var andDocumentMatchers = andSomeMatchers;
var andBranchedMatchers = andSomeMatchers;


// helpers used by compiled selector code
LocalCollection._f = {
  // XXX for _all and _in, consider building 'inquery' at compile time..

  _type: function (v) {
    if (typeof v === "number")
      return 1;
    if (typeof v === "string")
      return 2;
    if (typeof v === "boolean")
      return 8;
    if (isArray(v))
      return 4;
    if (v === null)
      return 10;
    if (v instanceof RegExp)
      // note that typeof(/x/) === "object"
      return 11;
    if (typeof v === "function")
      return 13;
    if (v instanceof Date)
      return 9;
    if (EJSON.isBinary(v))
      return 5;
    if (v instanceof LocalCollection._ObjectID)
      return 7;
    return 3; // object

    // XXX support some/all of these:
    // 14, symbol
    // 15, javascript code with scope
    // 16, 18: 32-bit/64-bit integer
    // 17, timestamp
    // 255, minkey
    // 127, maxkey
  },

  // deep equality test: use for literal document and array matches
  _equal: function (a, b) {
    return EJSON.equals(a, b, {keyOrderSensitive: true});
  },

  // maps a type code to a value that can be used to sort values of
  // different types
  _typeorder: function (t) {
    // http://www.mongodb.org/display/DOCS/What+is+the+Compare+Order+for+BSON+Types
    // XXX what is the correct sort position for Javascript code?
    // ('100' in the matrix below)
    // XXX minkey/maxkey
    return [-1,  // (not a type)
            1,   // number
            2,   // string
            3,   // object
            4,   // array
            5,   // binary
            -1,  // deprecated
            6,   // ObjectID
            7,   // bool
            8,   // Date
            0,   // null
            9,   // RegExp
            -1,  // deprecated
            100, // JS code
            2,   // deprecated (symbol)
            100, // JS code
            1,   // 32-bit int
            8,   // Mongo timestamp
            1    // 64-bit int
           ][t];
  },

  // compare two values of unknown type according to BSON ordering
  // semantics. (as an extension, consider 'undefined' to be less than
  // any other value.) return negative if a is less, positive if b is
  // less, or 0 if equal
  _cmp: function (a, b) {
    if (a === undefined)
      return b === undefined ? 0 : -1;
    if (b === undefined)
      return 1;
    var ta = LocalCollection._f._type(a);
    var tb = LocalCollection._f._type(b);
    var oa = LocalCollection._f._typeorder(ta);
    var ob = LocalCollection._f._typeorder(tb);
    if (oa !== ob)
      return oa < ob ? -1 : 1;
    if (ta !== tb)
      // XXX need to implement this if we implement Symbol or integers, or
      // Timestamp
      throw Error("Missing type coercion logic in _cmp");
    if (ta === 7) { // ObjectID
      // Convert to string.
      ta = tb = 2;
      a = a.toHexString();
      b = b.toHexString();
    }
    if (ta === 9) { // Date
      // Convert to millis.
      ta = tb = 1;
      a = a.getTime();
      b = b.getTime();
    }

    if (ta === 1) // double
      return a - b;
    if (tb === 2) // string
      return a < b ? -1 : (a === b ? 0 : 1);
    if (ta === 3) { // Object
      // this could be much more efficient in the expected case ...
      var to_array = function (obj) {
        var ret = [];
        for (var key in obj) {
          ret.push(key);
          ret.push(obj[key]);
        }
        return ret;
      };
      return LocalCollection._f._cmp(to_array(a), to_array(b));
    }
    if (ta === 4) { // Array
      for (var i = 0; ; i++) {
        if (i === a.length)
          return (i === b.length) ? 0 : -1;
        if (i === b.length)
          return 1;
        var s = LocalCollection._f._cmp(a[i], b[i]);
        if (s !== 0)
          return s;
      }
    }
    if (ta === 5) { // binary
      // Surprisingly, a small binary blob is always less than a large one in
      // Mongo.
      if (a.length !== b.length)
        return a.length - b.length;
      for (i = 0; i < a.length; i++) {
        if (a[i] < b[i])
          return -1;
        if (a[i] > b[i])
          return 1;
      }
      return 0;
    }
    if (ta === 8) { // boolean
      if (a) return b ? 0 : 1;
      return b ? -1 : 0;
    }
    if (ta === 10) // null
      return 0;
    if (ta === 11) // regexp
      throw Error("Sorting not supported on regular expression"); // XXX
    // 13: javascript code
    // 14: symbol
    // 15: javascript code with scope
    // 16: 32-bit integer
    // 17: timestamp
    // 18: 64-bit integer
    // 255: minkey
    // 127: maxkey
    if (ta === 13) // javascript code
      throw Error("Sorting not supported on Javascript code"); // XXX
    throw Error("Unknown type to sort");
  }
};

// Oddball function used by upsert.
LocalCollection._removeDollarOperators = function (selector) {
  var selectorDoc = {};
  for (var k in selector)
    if (k.substr(0, 1) !== '$')
      selectorDoc[k] = selector[k];
  return selectorDoc;
};


// ordered: bool.
// old_results and new_results: collections of documents.
//    if ordered, they are arrays.
//    if unordered, they are IdMaps
LocalCollection._diffQueryChanges = function (ordered, oldResults, newResults,
                                       observer) {
  if (ordered)
    LocalCollection._diffQueryOrderedChanges(
      oldResults, newResults, observer);
  else
    LocalCollection._diffQueryUnorderedChanges(
      oldResults, newResults, observer);
};

LocalCollection._diffQueryUnorderedChanges = function (oldResults, newResults,
                                                       observer) {
  if (observer.movedBefore) {
    throw new Error("_diffQueryUnordered called with a movedBefore observer!");
  }

  newResults.forEach(function (newDoc, id) {
    var oldDoc = oldResults.get(id);
    if (oldDoc) {
      if (observer.changed && !EJSON.equals(oldDoc, newDoc)) {
        observer.changed(
          id, LocalCollection._makeChangedFields(newDoc, oldDoc));
      }
    } else if (observer.added) {
      var fields = EJSON.clone(newDoc);
      delete fields._id;
      observer.added(newDoc._id, fields);
    }
  });

  if (observer.removed) {
    oldResults.forEach(function (oldDoc, id) {
      if (!newResults.has(id))
        observer.removed(id);
    });
  }
};


LocalCollection._diffQueryOrderedChanges = function (old_results, new_results, observer) {

  var new_presence_of_id = {};
  _.each(new_results, function (doc) {
    if (new_presence_of_id[doc._id])
      Meteor._debug("Duplicate _id in new_results");
    new_presence_of_id[doc._id] = true;
  });

  var old_index_of_id = {};
  _.each(old_results, function (doc, i) {
    if (doc._id in old_index_of_id)
      Meteor._debug("Duplicate _id in old_results");
    old_index_of_id[doc._id] = i;
  });

  // ALGORITHM:
  //
  // To determine which docs should be considered "moved" (and which
  // merely change position because of other docs moving) we run
  // a "longest common subsequence" (LCS) algorithm.  The LCS of the
  // old doc IDs and the new doc IDs gives the docs that should NOT be
  // considered moved.

  // To actually call the appropriate callbacks to get from the old state to the
  // new state:

  // First, we call removed() on all the items that only appear in the old
  // state.

  // Then, once we have the items that should not move, we walk through the new
  // results array group-by-group, where a "group" is a set of items that have
  // moved, anchored on the end by an item that should not move.  One by one, we
  // move each of those elements into place "before" the anchoring end-of-group
  // item, and fire changed events on them if necessary.  Then we fire a changed
  // event on the anchor, and move on to the next group.  There is always at
  // least one group; the last group is anchored by a virtual "null" id at the
  // end.

  // Asymptotically: O(N k) where k is number of ops, or potentially
  // O(N log N) if inner loop of LCS were made to be binary search.


  //////// LCS (longest common sequence, with respect to _id)
  // (see Wikipedia article on Longest Increasing Subsequence,
  // where the LIS is taken of the sequence of old indices of the
  // docs in new_results)
  //
  // unmoved: the output of the algorithm; members of the LCS,
  // in the form of indices into new_results
  var unmoved = [];
  // max_seq_len: length of LCS found so far
  var max_seq_len = 0;
  // seq_ends[i]: the index into new_results of the last doc in a
  // common subsequence of length of i+1 <= max_seq_len
  var N = new_results.length;
  var seq_ends = new Array(N);
  // ptrs:  the common subsequence ending with new_results[n] extends
  // a common subsequence ending with new_results[ptr[n]], unless
  // ptr[n] is -1.
  var ptrs = new Array(N);
  // virtual sequence of old indices of new results
  var old_idx_seq = function(i_new) {
    return old_index_of_id[new_results[i_new]._id];
  };
  // for each item in new_results, use it to extend a common subsequence
  // of length j <= max_seq_len
  for(var i=0; i<N; i++) {
    if (old_index_of_id[new_results[i]._id] !== undefined) {
      var j = max_seq_len;
      // this inner loop would traditionally be a binary search,
      // but scanning backwards we will likely find a subseq to extend
      // pretty soon, bounded for example by the total number of ops.
      // If this were to be changed to a binary search, we'd still want
      // to scan backwards a bit as an optimization.
      while (j > 0) {
        if (old_idx_seq(seq_ends[j-1]) < old_idx_seq(i))
          break;
        j--;
      }

      ptrs[i] = (j === 0 ? -1 : seq_ends[j-1]);
      seq_ends[j] = i;
      if (j+1 > max_seq_len)
        max_seq_len = j+1;
    }
  }

  // pull out the LCS/LIS into unmoved
  var idx = (max_seq_len === 0 ? -1 : seq_ends[max_seq_len-1]);
  while (idx >= 0) {
    unmoved.push(idx);
    idx = ptrs[idx];
  }
  // the unmoved item list is built backwards, so fix that
  unmoved.reverse();

  // the last group is always anchored by the end of the result list, which is
  // an id of "null"
  unmoved.push(new_results.length);

  _.each(old_results, function (doc) {
    if (!new_presence_of_id[doc._id])
      observer.removed && observer.removed(doc._id);
  });
  // for each group of things in the new_results that is anchored by an unmoved
  // element, iterate through the things before it.
  var startOfGroup = 0;
  _.each(unmoved, function (endOfGroup) {
    var groupId = new_results[endOfGroup] ? new_results[endOfGroup]._id : null;
    var oldDoc;
    var newDoc;
    var fields;
    for (var i = startOfGroup; i < endOfGroup; i++) {
      newDoc = new_results[i];
      if (!_.has(old_index_of_id, newDoc._id)) {
        fields = EJSON.clone(newDoc);
        delete fields._id;
        observer.addedBefore && observer.addedBefore(newDoc._id, fields, groupId);
        observer.added && observer.added(newDoc._id, fields);
      } else {
        // moved
        oldDoc = old_results[old_index_of_id[newDoc._id]];
        fields = LocalCollection._makeChangedFields(newDoc, oldDoc);
        if (!_.isEmpty(fields)) {
          observer.changed && observer.changed(newDoc._id, fields);
        }
        observer.movedBefore && observer.movedBefore(newDoc._id, groupId);
      }
    }
    if (groupId) {
      newDoc = new_results[endOfGroup];
      oldDoc = old_results[old_index_of_id[newDoc._id]];
      fields = LocalCollection._makeChangedFields(newDoc, oldDoc);
      if (!_.isEmpty(fields)) {
        observer.changed && observer.changed(newDoc._id, fields);
      }
    }
    startOfGroup = endOfGroup+1;
  });


};


// General helper for diff-ing two objects.
// callbacks is an object like so:
// { leftOnly: function (key, leftValue) {...},
//   rightOnly: function (key, rightValue) {...},
//   both: function (key, leftValue, rightValue) {...},
// }
LocalCollection._diffObjects = function (left, right, callbacks) {
  _.each(left, function (leftValue, key) {
    if (_.has(right, key))
      callbacks.both && callbacks.both(key, leftValue, right[key]);
    else
      callbacks.leftOnly && callbacks.leftOnly(key, leftValue);
  });
  if (callbacks.rightOnly) {
    _.each(right, function(rightValue, key) {
      if (!_.has(left, key))
        callbacks.rightOnly(key, rightValue);
    });
  }
};

// XXX need a strategy for passing the binding of $ into this
// function, from the compiled selector
//
// maybe just {key.up.to.just.before.dollarsign: array_index}
//
// XXX atomicity: if one modification fails, do we roll back the whole
// change?
//
// options:
//   - isInsert is set when _modify is being called to compute the document to
//     insert as part of an upsert operation. We use this primarily to figure
//     out when to set the fields in $setOnInsert, if present.
LocalCollection._modify = function (doc, mod, options) {
  options = options || {};
  if (!isPlainObject(mod))
    throw MinimongoError("Modifier must be an object");
  var isModifier = isOperatorObject(mod);

  var newDoc;

  if (!isModifier) {
    if (mod._id && !EJSON.equals(doc._id, mod._id))
      throw MinimongoError("Cannot change the _id of a document");

    // replace the whole document
    for (var k in mod) {
      if (/\./.test(k))
        throw MinimongoError(
          "When replacing document, field name may not contain '.'");
    }
    newDoc = mod;
  } else {
    // apply modifiers to the doc.
    newDoc = EJSON.clone(doc);

    _.each(mod, function (operand, op) {
      var modFunc = MODIFIERS[op];
      // Treat $setOnInsert as $set if this is an insert.
      if (options.isInsert && op === '$setOnInsert')
        modFunc = MODIFIERS['$set'];
      if (!modFunc)
        throw MinimongoError("Invalid modifier specified " + op);
      _.each(operand, function (arg, keypath) {
        // XXX mongo doesn't allow mod field names to end in a period,
        // but I don't see why.. it allows '' as a key, as does JS
        if (keypath.length && keypath[keypath.length-1] === '.')
          throw MinimongoError(
            "Invalid mod field name, may not end in a period");

        if (keypath === '_id')
          throw MinimongoError("Mod on _id not allowed");

        var keyparts = keypath.split('.');
        var noCreate = _.has(NO_CREATE_MODIFIERS, op);
        var forbidArray = (op === "$rename");
        var target = findModTarget(newDoc, keyparts, {
          noCreate: NO_CREATE_MODIFIERS[op],
          forbidArray: (op === "$rename"),
          arrayIndex: options.arrayIndex
        });
        var field = keyparts.pop();
        modFunc(target, field, arg, keypath, newDoc);
      });
    });
  }

  // move new document into place.
  _.each(_.keys(doc), function (k) {
    // Note: this used to be for (var k in doc) however, this does not
    // work right in Opera. Deleting from a doc while iterating over it
    // would sometimes cause opera to skip some keys.

    // isInsert: if we're constructing a document to insert (via upsert)
    // and we're in replacement mode, not modify mode, DON'T take the
    // _id from the query.  This matches mongo's behavior.
    if (k !== '_id' || options.isInsert)
      delete doc[k];
  });
  _.each(newDoc, function (v, k) {
    doc[k] = v;
  });
};

// for a.b.c.2.d.e, keyparts should be ['a', 'b', 'c', '2', 'd', 'e'],
// and then you would operate on the 'e' property of the returned
// object.
//
// if options.noCreate is falsey, creates intermediate levels of
// structure as necessary, like mkdir -p (and raises an exception if
// that would mean giving a non-numeric property to an array.) if
// options.noCreate is true, return undefined instead.
//
// may modify the last element of keyparts to signal to the caller that it needs
// to use a different value to index into the returned object (for example,
// ['a', '01'] -> ['a', 1]).
//
// if forbidArray is true, return null if the keypath goes through an array.
//
// if options.arrayIndex is defined, use this for the (first) '$' in the path.
var findModTarget = function (doc, keyparts, options) {
  options = options || {};
  var usedArrayIndex = false;
  for (var i = 0; i < keyparts.length; i++) {
    var last = (i === keyparts.length - 1);
    var keypart = keyparts[i];
    var indexable = isIndexable(doc);
    if (!indexable) {
      if (options.noCreate)
        return undefined;
      var e = MinimongoError(
        "cannot use the part '" + keypart + "' to traverse " + doc);
      e.setPropertyError = true;
      throw e;
    }
    if (doc instanceof Array) {
      if (options.forbidArray)
        return null;
      if (keypart === '$') {
        if (usedArrayIndex)
          throw MinimongoError("Too many positional (i.e. '$') elements");
        if (options.arrayIndex === undefined) {
          throw MinimongoError("The positional operator did not find the " +
                               "match needed from the query");
        }
        keypart = options.arrayIndex;
        usedArrayIndex = true;
      } else if (isNumericKey(keypart)) {
        keypart = parseInt(keypart);
      } else {
        if (options.noCreate)
          return undefined;
        throw MinimongoError(
          "can't append to array using string field name ["
                    + keypart + "]");
      }
      if (last)
        // handle 'a.01'
        keyparts[i] = keypart;
      if (options.noCreate && keypart >= doc.length)
        return undefined;
      while (doc.length < keypart)
        doc.push(null);
      if (!last) {
        if (doc.length === keypart)
          doc.push({});
        else if (typeof doc[keypart] !== "object")
          throw MinimongoError("can't modify field '" + keyparts[i + 1] +
                      "' of list value " + JSON.stringify(doc[keypart]));
      }
    } else {
      if (keypart.length && keypart.substr(0, 1) === '$')
        throw MinimongoError("can't set field named " + keypart);
      if (!(keypart in doc)) {
        if (options.noCreate)
          return undefined;
        if (!last)
          doc[keypart] = {};
      }
    }

    if (last)
      return doc;
    doc = doc[keypart];
  }

  // notreached
};

var NO_CREATE_MODIFIERS = {
  $unset: true,
  $pop: true,
  $rename: true,
  $pull: true,
  $pullAll: true
};

var MODIFIERS = {
  $inc: function (target, field, arg) {
    if (typeof arg !== "number")
      throw MinimongoError("Modifier $inc allowed for numbers only");
    if (field in target) {
      if (typeof target[field] !== "number")
        throw MinimongoError("Cannot apply $inc modifier to non-number");
      target[field] += arg;
    } else {
      target[field] = arg;
    }
  },
  $set: function (target, field, arg) {
    if (!_.isObject(target)) { // not an array or an object
      var e = MinimongoError("Cannot set property on non-object field");
      e.setPropertyError = true;
      throw e;
    }
    if (target === null) {
      var e = MinimongoError("Cannot set property on null");
      e.setPropertyError = true;
      throw e;
    }
    target[field] = EJSON.clone(arg);
  },
  $setOnInsert: function (target, field, arg) {
    // converted to `$set` in `_modify`
  },
  $unset: function (target, field, arg) {
    if (target !== undefined) {
      if (target instanceof Array) {
        if (field in target)
          target[field] = null;
      } else
        delete target[field];
    }
  },
  $push: function (target, field, arg) {
    if (target[field] === undefined)
      target[field] = [];
    if (!(target[field] instanceof Array))
      throw MinimongoError("Cannot apply $push modifier to non-array");

    if (!(arg && arg.$each)) {
      // Simple mode: not $each
      target[field].push(EJSON.clone(arg));
      return;
    }

    // Fancy mode: $each (and maybe $slice and $sort)
    var toPush = arg.$each;
    if (!(toPush instanceof Array))
      throw MinimongoError("$each must be an array");

    // Parse $slice.
    var slice = undefined;
    if ('$slice' in arg) {
      if (typeof arg.$slice !== "number")
        throw MinimongoError("$slice must be a numeric value");
      // XXX should check to make sure integer
      if (arg.$slice > 0)
        throw MinimongoError("$slice in $push must be zero or negative");
      slice = arg.$slice;
    }

    // Parse $sort.
    var sortFunction = undefined;
    if (arg.$sort) {
      if (slice === undefined)
        throw MinimongoError("$sort requires $slice to be present");
      // XXX this allows us to use a $sort whose value is an array, but that's
      // actually an extension of the Node driver, so it won't work
      // server-side. Could be confusing!
      // XXX is it correct that we don't do geo-stuff here?
      sortFunction = new Sorter(arg.$sort).getComparator();
      for (var i = 0; i < toPush.length; i++) {
        if (LocalCollection._f._type(toPush[i]) !== 3) {
          throw MinimongoError("$push like modifiers using $sort " +
                      "require all elements to be objects");
        }
      }
    }

    // Actually push.
    for (var j = 0; j < toPush.length; j++)
      target[field].push(EJSON.clone(toPush[j]));

    // Actually sort.
    if (sortFunction)
      target[field].sort(sortFunction);

    // Actually slice.
    if (slice !== undefined) {
      if (slice === 0)
        target[field] = [];  // differs from Array.slice!
      else
        target[field] = target[field].slice(slice);
    }
  },
  $pushAll: function (target, field, arg) {
    if (!(typeof arg === "object" && arg instanceof Array))
      throw MinimongoError("Modifier $pushAll/pullAll allowed for arrays only");
    var x = target[field];
    if (x === undefined)
      target[field] = arg;
    else if (!(x instanceof Array))
      throw MinimongoError("Cannot apply $pushAll modifier to non-array");
    else {
      for (var i = 0; i < arg.length; i++)
        x.push(arg[i]);
    }
  },
  $addToSet: function (target, field, arg) {
    var x = target[field];
    if (x === undefined)
      target[field] = [arg];
    else if (!(x instanceof Array))
      throw MinimongoError("Cannot apply $addToSet modifier to non-array");
    else {
      var isEach = false;
      if (typeof arg === "object") {
        for (var k in arg) {
          if (k === "$each")
            isEach = true;
          break;
        }
      }
      var values = isEach ? arg["$each"] : [arg];
      _.each(values, function (value) {
        for (var i = 0; i < x.length; i++)
          if (LocalCollection._f._equal(value, x[i]))
            return;
        x.push(EJSON.clone(value));
      });
    }
  },
  $pop: function (target, field, arg) {
    if (target === undefined)
      return;
    var x = target[field];
    if (x === undefined)
      return;
    else if (!(x instanceof Array))
      throw MinimongoError("Cannot apply $pop modifier to non-array");
    else {
      if (typeof arg === 'number' && arg < 0)
        x.splice(0, 1);
      else
        x.pop();
    }
  },
  $pull: function (target, field, arg) {
    if (target === undefined)
      return;
    var x = target[field];
    if (x === undefined)
      return;
    else if (!(x instanceof Array))
      throw MinimongoError("Cannot apply $pull/pullAll modifier to non-array");
    else {
      var out = [];
      if (typeof arg === "object" && !(arg instanceof Array)) {
        // XXX would be much nicer to compile this once, rather than
        // for each document we modify.. but usually we're not
        // modifying that many documents, so we'll let it slide for
        // now

        // XXX Minimongo.Matcher isn't up for the job, because we need
        // to permit stuff like {$pull: {a: {$gt: 4}}}.. something
        // like {$gt: 4} is not normally a complete selector.
        // same issue as $elemMatch possibly?
        var matcher = new Minimongo.Matcher(arg);
        for (var i = 0; i < x.length; i++)
          if (!matcher.documentMatches(x[i]).result)
            out.push(x[i]);
      } else {
        for (var i = 0; i < x.length; i++)
          if (!LocalCollection._f._equal(x[i], arg))
            out.push(x[i]);
      }
      target[field] = out;
    }
  },
  $pullAll: function (target, field, arg) {
    if (!(typeof arg === "object" && arg instanceof Array))
      throw MinimongoError("Modifier $pushAll/pullAll allowed for arrays only");
    if (target === undefined)
      return;
    var x = target[field];
    if (x === undefined)
      return;
    else if (!(x instanceof Array))
      throw MinimongoError("Cannot apply $pull/pullAll modifier to non-array");
    else {
      var out = [];
      for (var i = 0; i < x.length; i++) {
        var exclude = false;
        for (var j = 0; j < arg.length; j++) {
          if (LocalCollection._f._equal(x[i], arg[j])) {
            exclude = true;
            break;
          }
        }
        if (!exclude)
          out.push(x[i]);
      }
      target[field] = out;
    }
  },
  $rename: function (target, field, arg, keypath, doc) {
    if (keypath === arg)
      // no idea why mongo has this restriction..
      throw MinimongoError("$rename source must differ from target");
    if (target === null)
      throw MinimongoError("$rename source field invalid");
    if (typeof arg !== "string")
      throw MinimongoError("$rename target must be a string");
    if (target === undefined)
      return;
    var v = target[field];
    delete target[field];

    var keyparts = arg.split('.');
    var target2 = findModTarget(doc, keyparts, {forbidArray: true});
    if (target2 === null)
      throw MinimongoError("$rename target field invalid");
    var field2 = keyparts.pop();
    target2[field2] = v;
  },
  $bit: function (target, field, arg) {
    // XXX mongo only supports $bit on integers, and we only support
    // native javascript numbers (doubles) so far, so we can't support $bit
    throw MinimongoError("$bit is not supported");
  }
};


LocalCollection._looksLikeObjectID = function (str) {
  return str.length === 24 && str.match(/^[0-9a-f]*$/);
};

LocalCollection._ObjectID = function (hexString) {
  //random-based impl of Mongo ObjectID
  var self = this;
  if (hexString) {
    hexString = hexString.toLowerCase();
    if (!LocalCollection._looksLikeObjectID(hexString)) {
      throw new Error("Invalid hexadecimal string for creating an ObjectID");
    }
    // meant to work with _.isEqual(), which relies on structural equality
    self._str = hexString;
  } else {
    self._str = Random.hexString(24);
  }
};

LocalCollection._ObjectID.prototype.toString = function () {
  var self = this;
  return "ObjectID(\"" + self._str + "\")";
};

LocalCollection._ObjectID.prototype.equals = function (other) {
  var self = this;
  return other instanceof LocalCollection._ObjectID &&
    self.valueOf() === other.valueOf();
};

LocalCollection._ObjectID.prototype.clone = function () {
  var self = this;
  return new LocalCollection._ObjectID(self._str);
};

LocalCollection._ObjectID.prototype.typeName = function() {
  return "oid";
};

LocalCollection._ObjectID.prototype.getTimestamp = function() {
  var self = this;
  return parseInt(self._str.substr(0, 8), 16);
};

LocalCollection._ObjectID.prototype.valueOf =
    LocalCollection._ObjectID.prototype.toJSONValue =
    LocalCollection._ObjectID.prototype.toHexString =
    function () { return this._str; };

// Is this selector just shorthand for lookup by _id?
LocalCollection._selectorIsId = function (selector) {
  return (typeof selector === "string") ||
    (typeof selector === "number") ||
    selector instanceof LocalCollection._ObjectID;
};

// Is the selector just lookup by _id (shorthand or not)?
LocalCollection._selectorIsIdPerhapsAsObject = function (selector) {
  return LocalCollection._selectorIsId(selector) ||
    (selector && typeof selector === "object" &&
     selector._id && LocalCollection._selectorIsId(selector._id) &&
     _.size(selector) === 1);
};

// If this is a selector which explicitly constrains the match by ID to a finite
// number of documents, returns a list of their IDs.  Otherwise returns
// null. Note that the selector may have other restrictions so it may not even
// match those document!  We care about $in and $and since those are generated
// access-controlled update and remove.
LocalCollection._idsMatchedBySelector = function (selector) {
  // Is the selector just an ID?
  if (LocalCollection._selectorIsId(selector))
    return [selector];
  if (!selector)
    return null;

  // Do we have an _id clause?
  if (_.has(selector, '_id')) {
    // Is the _id clause just an ID?
    if (LocalCollection._selectorIsId(selector._id))
      return [selector._id];
    // Is the _id clause {_id: {$in: ["x", "y", "z"]}}?
    if (selector._id && selector._id.$in
        && _.isArray(selector._id.$in)
        && !_.isEmpty(selector._id.$in)
        && _.all(selector._id.$in, LocalCollection._selectorIsId)) {
      return selector._id.$in;
    }
    return null;
  }

  // If this is a top-level $and, and any of the clauses constrain their
  // documents, then the whole selector is constrained by any one clause's
  // constraint. (Well, by their intersection, but that seems unlikely.)
  if (selector.$and && _.isArray(selector.$and)) {
    for (var i = 0; i < selector.$and.length; ++i) {
      var subIds = LocalCollection._idsMatchedBySelector(selector.$and[i]);
      if (subIds)
        return subIds;
    }
  }

  return null;
};
/*Replaced by BetterObjectID.js --Ed
EJSON.addType("oid",  function (str) {
  return new LocalCollection._ObjectID(str);
});*/

EJSON.addType("oid",  function (str) {
  return new ObjectID(str);
});

LocalCollection._ObjectID = BetterObjectId;

LocalCollection._IdMap = function () {
  var self = this;
  self._map = {};
};

// Some of these methods are designed to match methods on OrderedDict, since
// (eg) ObserveMultiplex and _CachingChangeObserver use them interchangeably.
// (Conceivably, this should be replaced with "UnorderedDict" with a specific
// set of methods that overlap between the two.)

_.extend(LocalCollection._IdMap.prototype, {
  get: function (id) {
    var self = this;
    var key = LocalCollection._idStringify(id);
    return self._map[key];
  },
  set: function (id, value) {
    var self = this;
    var key = LocalCollection._idStringify(id);
    self._map[key] = value;
  },
  remove: function (id) {
    var self = this;
    var key = LocalCollection._idStringify(id);
    delete self._map[key];
  },
  has: function (id) {
    var self = this;
    var key = LocalCollection._idStringify(id);
    return _.has(self._map, key);
  },
  empty: function () {
    var self = this;
    return _.isEmpty(self._map);
  },
  clear: function () {
    var self = this;
    self._map = {};
  },
  // Iterates over the items in the map. Return `false` to break the loop.
  forEach: function (iterator) {
    var self = this;
    // don't use _.each, because we can't break out of it.
    var keys = _.keys(self._map);
    for (var i = 0; i < keys.length; i++) {
      var breakIfFalse = iterator.call(null, self._map[keys[i]],
                                       LocalCollection._idParse(keys[i]));
      if (breakIfFalse === false)
        return;
    }
  },
  size: function () {
    var self = this;
    return _.size(self._map);
  },
  setDefault: function (id, def) {
    var self = this;
    var key = LocalCollection._idStringify(id);
    if (_.has(self._map, key))
      return self._map[key];
    self._map[key] = def;
    return def;
  },
  // Assumes that values are EJSON-cloneable, and that we don't need to clone
  // IDs (ie, that nobody is going to mutate an ObjectId).
  clone: function () {
    var self = this;
    var clone = new LocalCollection._IdMap;
    self.forEach(function (value, id) {
      clone.set(id, EJSON.clone(value));
      });
    return clone;
  }
});


// Knows how to compile a fields projection to a predicate function.
// @returns - Function: a closure that filters out an object according to the
//            fields projection rules:
//            @param obj - Object: MongoDB-styled document
//            @returns - Object: a document with the fields filtered out
//                       according to projection rules. Doesn't retain subfields
//                       of passed argument.
LocalCollection._compileProjection = function (fields) {
  LocalCollection._checkSupportedProjection(fields);

  var _idProjection = _.isUndefined(fields._id) ? true : fields._id;
  var details = projectionDetails(fields);

  // returns transformed doc according to ruleTree
  var transform = function (doc, ruleTree) {
    // Special case for "sets"
    if (_.isArray(doc))
      return _.map(doc, function (subdoc) { return transform(subdoc, ruleTree); });

    var res = details.including ? {} : EJSON.clone(doc);
    _.each(ruleTree, function (rule, key) {
      if (!_.has(doc, key))
        return;
      if (_.isObject(rule)) {
        // For sub-objects/subsets we branch
        if (_.isObject(doc[key]))
          res[key] = transform(doc[key], rule);
        // Otherwise we don't even touch this subfield
      } else if (details.including)
        res[key] = EJSON.clone(doc[key]);
      else
        delete res[key];
    });

    return res;
  };

  return function (obj) {
    var res = transform(obj, details.tree);

    if (_idProjection && _.has(obj, '_id'))
      res._id = obj._id;
    if (!_idProjection && _.has(res, '_id'))
      delete res._id;
    return res;
  };
};

// Traverses the keys of passed projection and constructs a tree where all
// leaves are either all True or all False
// @returns Object:
//  - tree - Object - tree representation of keys involved in projection
//  (exception for '_id' as it is a special case handled separately)
//  - including - Boolean - "take only certain fields" type of projection
projectionDetails = function (fields) {
  // Find the non-_id keys (_id is handled specially because it is included unless
  // explicitly excluded). Sort the keys, so that our code to detect overlaps
  // like 'foo' and 'foo.bar' can assume that 'foo' comes first.
  var fieldsKeys = _.keys(fields).sort();

  // If there are other rules other than '_id', treat '_id' differently in a
  // separate case. If '_id' is the only rule, use it to understand if it is
  // including/excluding projection.
  if (fieldsKeys.length > 0 && !(fieldsKeys.length === 1 && fieldsKeys[0] === '_id'))
    fieldsKeys = _.reject(fieldsKeys, function (key) { return key === '_id'; });

  var including = null; // Unknown

  _.each(fieldsKeys, function (keyPath) {
    var rule = !!fields[keyPath];
    if (including === null)
      including = rule;
    if (including !== rule)
      // This error message is copies from MongoDB shell
      throw MinimongoError("You cannot currently mix including and excluding fields.");
  });


  var projectionRulesTree = pathsToTree(
    fieldsKeys,
    function (path) { return including; },
    function (node, path, fullPath) {
      // Check passed projection fields' keys: If you have two rules such as
      // 'foo.bar' and 'foo.bar.baz', then the result becomes ambiguous. If
      // that happens, there is a probability you are doing something wrong,
      // framework should notify you about such mistake earlier on cursor
      // compilation step than later during runtime.  Note, that real mongo
      // doesn't do anything about it and the later rule appears in projection
      // project, more priority it takes.
      //
      // Example, assume following in mongo shell:
      // > db.coll.insert({ a: { b: 23, c: 44 } })
      // > db.coll.find({}, { 'a': 1, 'a.b': 1 })
      // { "_id" : ObjectId("520bfe456024608e8ef24af3"), "a" : { "b" : 23 } }
      // > db.coll.find({}, { 'a.b': 1, 'a': 1 })
      // { "_id" : ObjectId("520bfe456024608e8ef24af3"), "a" : { "b" : 23, "c" : 44 } }
      //
      // Note, how second time the return set of keys is different.

      var currentPath = fullPath;
      var anotherPath = path;
      throw MinimongoError("both " + currentPath + " and " + anotherPath +
                           " found in fields option, using both of them may trigger " +
                           "unexpected behavior. Did you mean to use only one of them?");
    });

  return {
    tree: projectionRulesTree,
    including: including
  };
};

// paths - Array: list of mongo style paths
// newLeafFn - Function: of form function(path) should return a scalar value to
//                       put into list created for that path
// conflictFn - Function: of form function(node, path, fullPath) is called
//                        when building a tree path for 'fullPath' node on
//                        'path' was already a leaf with a value. Must return a
//                        conflict resolution.
// initial tree - Optional Object: starting tree.
// @returns - Object: tree represented as a set of nested objects
pathsToTree = function (paths, newLeafFn, conflictFn, tree) {
  tree = tree || {};
  _.each(paths, function (keyPath) {
    var treePos = tree;
    var pathArr = keyPath.split('.');

    // use _.all just for iteration with break
    var success = _.all(pathArr.slice(0, -1), function (key, idx) {
      if (!_.has(treePos, key))
        treePos[key] = {};
      else if (!_.isObject(treePos[key])) {
        treePos[key] = conflictFn(treePos[key],
                                  pathArr.slice(0, idx + 1).join('.'),
                                  keyPath);
        // break out of loop if we are failing for this path
        if (!_.isObject(treePos[key]))
          return false;
      }

      treePos = treePos[key];
      return true;
    });

    if (success) {
      var lastKey = _.last(pathArr);
      if (!_.has(treePos, lastKey))
        treePos[lastKey] = newLeafFn(keyPath);
      else
        treePos[lastKey] = conflictFn(treePos[lastKey], keyPath, keyPath);
    }
  });

  return tree;
};

LocalCollection._checkSupportedProjection = function (fields) {
  if (!_.isObject(fields) || _.isArray(fields))
    throw MinimongoError("fields option must be an object");

  _.each(fields, function (val, keyPath) {
    if (_.contains(keyPath.split('.'), '$'))
      throw MinimongoError("Minimongo doesn't support $ operator in projections yet.");
    if (_.indexOf([1, 0, true, false], val) === -1)
      throw MinimongoError("Projection values should be one of 1, 0, true, or false");
  });
};

// Knows how to combine a mongo selector and a fields projection to a new fields
// projection taking into account active fields from the passed selector.
// @returns Object - projection object (same as fields option of mongo cursor)
Minimongo.Matcher.prototype.combineIntoProjection = function (projection) {
  var self = this;
  var selectorPaths = self._getPathsElidingNumericKeys();

  // Special case for $where operator in the selector - projection should depend
  // on all fields of the document. getSelectorPaths returns a list of paths
  // selector depends on. If one of the paths is '' (empty string) representing
  // the root or the whole document, complete projection should be returned.
  if (_.contains(selectorPaths, ''))
    return {};

  var prjDetails = projectionDetails(projection);
  var tree = prjDetails.tree;
  var mergedProjection = {};

  // merge the paths to include
  tree = pathsToTree(selectorPaths,
                     function (path) { return true; },
                     function (node, path, fullPath) { return true; },
                     tree);
  mergedProjection = treeToPaths(tree);
  if (prjDetails.including) {
    // both selector and projection are pointing on fields to include
    // so we can just return the merged tree
    return mergedProjection;
  } else {
    // selector is pointing at fields to include
    // projection is pointing at fields to exclude
    // make sure we don't exclude important paths
    var mergedExclProjection = {};
    _.each(mergedProjection, function (incl, path) {
      if (!incl)
        mergedExclProjection[path] = false;
    });

    return mergedExclProjection;
  }
};

Minimongo.Matcher.prototype._getPathsElidingNumericKeys = function () {
  var self = this;
  return _.map(self._getPaths(), function (path) {
    return _.reject(path.split('.'), isNumericKey).join('.');
  });
};

// Returns a set of key paths similar to
// { 'foo.bar': 1, 'a.b.c': 1 }
var treeToPaths = function (tree, prefix) {
  prefix = prefix || '';
  var result = {};

  _.each(tree, function (val, key) {
    if (_.isObject(val))
      _.extend(result, treeToPaths(val, prefix + key + '.'));
    else
      result[prefix + key] = val;
  });

  return result;
};

// Returns true if the modifier applied to some document may change the result
// of matching the document by selector
// The modifier is always in a form of Object:
//  - $set
//    - 'a.b.22.z': value
//    - 'foo.bar': 42
//  - $unset
//    - 'abc.d': 1
Minimongo.Matcher.prototype.affectedByModifier = function (modifier) {
  var self = this;
  // safe check for $set/$unset being objects
  modifier = _.extend({ $set: {}, $unset: {} }, modifier);
  var modifiedPaths = _.keys(modifier.$set).concat(_.keys(modifier.$unset));
  var meaningfulPaths = self._getPaths();

  return _.any(modifiedPaths, function (path) {
    var mod = path.split('.');
    return _.any(meaningfulPaths, function (meaningfulPath) {
      var sel = meaningfulPath.split('.');
      var i = 0, j = 0;

      while (i < sel.length && j < mod.length) {
        if (isNumericKey(sel[i]) && isNumericKey(mod[j])) {
          // foo.4.bar selector affected by foo.4 modifier
          // foo.3.bar selector unaffected by foo.4 modifier
          if (sel[i] === mod[j])
            i++, j++;
          else
            return false;
        } else if (isNumericKey(sel[i])) {
          // foo.4.bar selector unaffected by foo.bar modifier
          return false;
        } else if (isNumericKey(mod[j])) {
          j++;
        } else if (sel[i] === mod[j])
          i++, j++;
        else
          return false;
      }

      // One is a prefix of another, taking numeric fields into account
      return true;
    });
  });
};

// @param modifier - Object: MongoDB-styled modifier with `$set`s and `$unsets`
//                           only. (assumed to come from oplog)
// @returns - Boolean: if after applying the modifier, selector can start
//                     accepting the modified value.
// NOTE: assumes that document affected by modifier didn't match this Matcher
// before, so if modifier can't convince selector in a positive change it would
// stay 'false'.
// Currently doesn't support $-operators and numeric indices precisely.
Minimongo.Matcher.prototype.canBecomeTrueByModifier = function (modifier) {
  var self = this;
  if (!this.affectedByModifier(modifier))
    return false;

  modifier = _.extend({$set:{}, $unset:{}}, modifier);
  var modifierPaths = _.keys(modifier.$set).concat(_.keys(modifier.$unset));

  if (!self.isSimple())
    return true;

  if (_.any(self._getPaths(), pathHasNumericKeys) ||
      _.any(modifierPaths, pathHasNumericKeys))
    return true;

  // check if there is a $set or $unset that indicates something is an
  // object rather than a scalar in the actual object where we saw $-operator
  // NOTE: it is correct since we allow only scalars in $-operators
  // Example: for selector {'a.b': {$gt: 5}} the modifier {'a.b.c':7} would
  // definitely set the result to false as 'a.b' appears to be an object.
  var expectedScalarIsObject = _.any(self._selector, function (sel, path) {
    if (! isOperatorObject(sel))
      return false;
    return _.any(modifierPaths, function (modifierPath) {
      return startsWith(modifierPath, path + '.');
    });
  });

  if (expectedScalarIsObject)
    return false;

  // See if we can apply the modifier on the ideally matching object. If it
  // still matches the selector, then the modifier could have turned the real
  // object in the database into something matching.
  var matchingDocument = EJSON.clone(self.matchingDocument());

  // The selector is too complex, anything can happen.
  if (matchingDocument === null)
    return true;

  try {
    LocalCollection._modify(matchingDocument, modifier);
  } catch (e) {
    // Couldn't set a property on a field which is a scalar or null in the
    // selector.
    // Example:
    // real document: { 'a.b': 3 }
    // selector: { 'a': 12 }
    // converted selector (ideal document): { 'a': 12 }
    // modifier: { $set: { 'a.b': 4 } }
    // We don't know what real document was like but from the error raised by
    // $set on a scalar field we can reason that the structure of real document
    // is completely different.
    if (e.name === "MinimongoError" && e.setPropertyError)
      return false;
    throw e;
  }

  return self.documentMatches(matchingDocument).result;
};

// Returns an object that would match the selector if possible or null if the
// selector is too complex for us to analyze
// { 'a.b': { ans: 42 }, 'foo.bar': null, 'foo.baz': "something" }
// => { a: { b: { ans: 42 } }, foo: { bar: null, baz: "something" } }
Minimongo.Matcher.prototype.matchingDocument = function () {
  var self = this;

  // check if it was computed before
  if (self._matchingDocument !== undefined)
    return self._matchingDocument;

  // If the analysis of this selector is too hard for our implementation
  // fallback to "YES"
  var fallback = false;
  self._matchingDocument = pathsToTree(self._getPaths(),
    function (path) {
      var valueSelector = self._selector[path];
      if (isOperatorObject(valueSelector)) {
        // if there is a strict equality, there is a good
        // chance we can use one of those as "matching"
        // dummy value
        if (valueSelector.$in) {
          var matcher = new Minimongo.Matcher({ placeholder: valueSelector });

          // Return anything from $in that matches the whole selector for this
          // path. If nothing matches, returns `undefined` as nothing can make
          // this selector into `true`.
          return _.find(valueSelector.$in, function (x) {
            return matcher.documentMatches({ placeholder: x }).result;
          });
        } else if (onlyContainsKeys(valueSelector, ['$gt', '$gte', '$lt', '$lte'])) {
          var lowerBound = -Infinity, upperBound = Infinity;
          _.each(['$lte', '$lt'], function (op) {
            if (_.has(valueSelector, op) && valueSelector[op] < upperBound)
              upperBound = valueSelector[op];
          });
          _.each(['$gte', '$gt'], function (op) {
            if (_.has(valueSelector, op) && valueSelector[op] > lowerBound)
              lowerBound = valueSelector[op];
          });

          var middle = (lowerBound + upperBound) / 2;
          var matcher = new Minimongo.Matcher({ placeholder: valueSelector });
          if (!matcher.documentMatches({ placeholder: middle }).result &&
              (middle === lowerBound || middle === upperBound))
            fallback = true;

          return middle;
        } else if (onlyContainsKeys(valueSelector, ['$nin',' $ne'])) {
          // Since self._isSimple makes sure $nin and $ne are not combined with
          // objects or arrays, we can confidently return an empty object as it
          // never matches any scalar.
          return {};
        } else {
          fallback = true;
        }
      }
      return self._selector[path];
    },
    _.identity /*conflict resolution is no resolution*/);

  if (fallback)
    self._matchingDocument = null;

  return self._matchingDocument;
};

var getPaths = function (sel) {
  return _.keys(new Minimongo.Matcher(sel)._paths);
  /**
  return _.chain(sel).map(function (v, k) {
    // we don't know how to handle $where because it can be anything
    if (k === "$where")
      return ''; // matches everything
    // we branch from $or/$and/$nor operator
    if (_.contains(['$or', '$and', '$nor'], k))
      return _.map(v, getPaths);
    // the value is a literal or some comparison operator
    return k;
  }).flatten().uniq().value();
**/
};

// A helper to ensure object has only certain keys
var onlyContainsKeys = function (obj, keys) {
  return _.all(obj, function (v, k) {
    return _.contains(keys, k);
  });
};

var pathHasNumericKeys = function (path) {
  return _.any(path.split('.'), isNumericKey);
}

// XXX from Underscore.String (http://epeli.github.com/underscore.string/)
var startsWith = function(str, starts) {
  return str.length >= starts.length &&
    str.substring(0, starts.length) === starts;
};

module['exports'] = LocalCollection;