/*
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */
// jshint node: true
'use strict';

var _      = require('lodash');
var domain = require('domain');

var Commit = require('./commit');

var STATUS_SCOPE = 'CI';

function Queue(processor, fbQueue, github, config) {
  this._processor   = processor;
  this._fbQueue     = fbQueue;
  this._github      = github;
  this._workerId    = config.worker.workerId;
  this._concurrency = config.worker.concurrency;
  this._jitter      = config.worker.jitter;
  this._itemTimeout = config.worker.itemTimeout;
  this._paused      = false;

  this._active = [];
}

Queue.prototype.start = function start() {
  this._fbQueue.on('value', function(snapshot) {
    this._itemsSnapshot = snapshot;
    this._withJitter(this._pluck);
  }.bind(this));

  // Periodically pick out tests that have failed & expired.
  setInterval(this._withJitter.bind(this, this._pluck), this._itemTimeout / 4);
};

Queue.prototype.add = function add(commit, done) {
  console.log('Adding', commit, 'to the queue');
  commit.setStatus(this._github, STATUS_SCOPE, 'pending', 'Waiting for worker');
  // Note that there is potential for dupes; but it should be rare, and isn't
  // the end of the world when it occurs. We just run the same tests again.
  this._fbQueue.push(commit.marshal(), done);
};

Queue.prototype.pause = function pause(done) {
  this._paused = true;
  if (this._active.length > 0) {
    this._pauseCallback = done;
  } else {
    done();
  }
};

Queue.prototype.resume = function resume() {
  this._paused = false;
  this._withJitter(this._pluck);
};

Queue.prototype._pluck = function _pluck() {
  if (this._paused) return;
  if (!this._itemsSnapshot || !this._claimNextItem(this._itemsSnapshot.val())) return;
  if (this._active.length >= this._concurrency) return;
  if (this._plucking) return;

  console.log('Inspecting the remote queue for something to claim');
  this._plucking = true;
  var commit;
  this._itemsSnapshot.ref().transaction(function(items) {
    commit = this._claimNextItem(items);
    if (commit) console.log('Attempting pluck for', commit);
    return items;

  }.bind(this), function(error, committed, snapshot) {
    this._plucking = false;
    if (!commit) return; // Nothing to pluck.

    if (error || !committed) {
      console.log('Pluck failed for', commit, 'committed:', committed, 'error:', error);
    } else {
      this._process(commit);
    }

    // Regardless, we want to keep trying (to fill our queue, or try again).
    if (commit) {
      this._withJitter(this._pluck);
    }
  }.bind(this));
};

Queue.prototype._claimNextItem = function _claimNextItem(items, dryRun) {
  if (!items) return;
  var keys = Object.keys(items);
  for (var i = 0, item; item = items[keys[i]]; i++) {
    if (item.activeWorker && ((item.activeAt || 0) + this._itemTimeout) > Date.now() ) continue;
    if (!dryRun) {
      item.activeWorker = this._workerId;
      item.activeAt     = Date.now();
      item['.priority'] = -item.activeAt;
    }
    var commit = Commit.from(item);
    commit._queueKey = keys[i];
    return commit;
  }
};

Queue.prototype._withJitter = function _withJitter(callback) {
  // https://github.com/joyent/node/issues/8065
  var delay = Math.round((Math.random() / 2 + 0.5) * this._jitter);
  setTimeout(callback.bind(this), delay);
};

Queue.prototype._process = function _process(commit) {
  console.log('Processing', commit);
  commit.setStatus(this._github, STATUS_SCOPE, 'pending', 'Running tests');
  this._active.push(commit);
  this._processor.run(commit, function(error) {
    if (error) {
      commit.setStatus(this._github, STATUS_SCOPE, 'failure', 'Tests failed');
    } else {
      commit.setStatus(this._github, STATUS_SCOPE, 'success', 'Tests passed');
    }
    this._cleanup(commit);
  }.bind(this));
};

Queue.prototype.remove = function remove(commit, done) {
  console.log('Removing', commit, 'from the queue');
  var commitNeedle = commit.marshal();

  // handle active test runs
  var currentlyActive = _.filter(this._active, commitNeedle);
  if (currentlyActive.length) {
    console.log('Killing active test for commit:', commit);
    _.each(currentlyActive, function(commit) {
      this._processor.cancel(commit);
    }.bind(this));
    done();

  } else {

    this._itemsSnapshot.ref().transaction(function(items) {
      var keys = Object.keys(items);
      var omitKeys = [];
      if (keys.length > 0) {
        for (var i = 0, item, c; item = items[keys[i]]; i++) {
          // use lodash filter as a fuzzy equality check
          c = [Commit.from(item)];
          if (_.filter(c, commitNeedle).length > 0) {
            omitKeys.push(keys[i]);
          }
        }
        // filter out commit from queue
        items = _.omit(items, omitKeys);
      }
      return items;
    }, function(error, committed, snapshot) {
      if (error || !committed) {
        console.log('Remove failed for', commit, 'error:', error);
        done(error);
      } else {
        console.log('removed from queue');
        done();
      }
    });
  }
};

Queue.prototype._cleanup = function _cleanup(commit) {
  console.log('Cleaning up', commit);
  this._active = _.without(this._active, commit);
  this._fbQueue.child(commit._queueKey).remove();

  if (this._pauseCallback) {
    this._pauseCallback();
  } else {
    this._pluck();
  }
};

module.exports = Queue;
