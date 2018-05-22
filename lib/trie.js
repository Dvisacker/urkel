/*!
 * trie.js - patricia merkle trie implementation
 * Copyright (c) 2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 *
 * Patricia Merkle Tries:
 *   https://github.com/ethereum/wiki/wiki/Patricia-Tree
 *
 * Parts of this software are based on go-ethereum:
 *   Copyright (C) 2014 The go-ethereum Authors.
 *   https://github.com/ethereum/go-ethereum/tree/master/trie
 */

'use strict';

const assert = require('assert');
const nodes = require('./nodes');
const common = require('./common');
const proof = require('./proof');
const Hasher = require('./hasher');
const {Iterator} = require('./iterator');
const {MissingNodeError} = require('./errors');

/*
 * Constants
 */

const {
  ensureHash,
  emptyRoot,
  toNibbles,
  prefixLen,
  concat,
  startsWith,
  byte
} = common;

const {
  NodeFlags,
  HashNode,
  ShortNode,
  FullNode,
  ValueNode,
  NIL,
  decodeNode
} = nodes;

const {
  NULLNODE,
  HASHNODE,
  SHORTNODE,
  FULLNODE,
  VALUENODE
} = nodes.types;

const STATE_KEY = Buffer.from([0x73]);

/**
 * Patricia Merkle Trie
 */

class Trie {
  /**
   * Create a trie.
   * @constructor
   * @param {Object} hash
   * @param {Object} [db=null]
   * @param {Number} [limit=4]
   */

  constructor(hash, db, limit) {
    if (limit == null)
      limit = 4;

    assert(hash && typeof hash.digest === 'function');
    assert(!db || typeof db === 'object');
    assert((limit >>> 0) === limit);

    this.hash = ensureHash(hash);
    this.emptyRoot = emptyRoot(hash);
    this.db = db || null;
    this.originalRoot = this.emptyRoot;
    this.root = NIL;
    this.cacheGen = 0;
    this.cacheLimit = limit;
  }

  digest(data) {
    return this.hash.digest(data);
  }

  flags() {
    return new NodeFlags(this.cacheGen, true);
  }

  hashNode(root) {
    return new HashNode(root, this.hash);
  }

  shortNode(key, value) {
    return new ShortNode(key, value, this.flags());
  }

  fullNode() {
    return new FullNode(this.flags());
  }

  valueNode(value) {
    return new ValueNode(value);
  }

  async open(root) {
    if (typeof root === 'string')
      root = Buffer.from(root, 'hex');

    assert(!root || Buffer.isBuffer(root));

    // Try to retrieve best state.
    if (!root && this.db)
      root = await this.db.get(STATE_KEY);

    if (root && !root.equals(this.emptyRoot)) {
      assert(root.length === this.hash.size);

      if (!this.db)
        throw new Error('Cannot use root without database.');

      if (!await this.db.has(root)) {
        throw new MissingNodeError({
          rootHash: root,
          nodeHash: root
        });
      }

      this.originalRoot = root;
      this.root = this.hashNode(root);
    }
  }

  async close() {
    this.root = NIL;
    this.originalRoot = this.emptyRoot;
    this.cacheGen = 0;
  }

  async get(key) {
    const k = toNibbles(key);
    const [val, root, res] = await this._get(this.root, k, 0);

    if (res)
      this.root = root;

    return val;
  }

  async _get(n, key, pos) {
    assert(pos <= key.length);

    switch (n.type) {
      case NULLNODE: {
        return [null, NIL, false];
      }
      case VALUENODE: {
        return [n.data, n, false];
      }
      case SHORTNODE: {
        if (!startsWith(key, n.key, pos)) {
          // Key not found.
          return [null, n, false];
        }

        const [val, nn, res] =
          await this._get(n.value, key, pos + n.key.length);

        if (res) {
          n = n.clone();
          n.value = nn;
        }

        return [val, n, res];
      }
      case FULLNODE: {
        const c = n.children[key[pos]];
        const [val, nn, res] = await this._get(c, key, pos + 1);

        if (res) {
          n = n.clone();
          n.children[key[pos]] = nn;
        }

        return [val, n, res];
      }
      case HASHNODE: {
        const child = await this.resolveHash(n, key, pos);
        const [val, nn] = await this._get(child, key, pos);
        return [val, nn, true];
      }
      default: {
        throw new Error('Invalid node type.');
      }
    }
  }

  async insert(key, value) {
    assert(Buffer.isBuffer(value));

    const k = toNibbles(key);
    const node = this.valueNode(value);
    const [, root] = await this._insert(this.root, k, 0, node);

    this.root = root;
  }

  async _insert(n, key, pos, value) {
    assert(pos <= key.length);

    if (key.length - pos === 0) {
      if (n.isValue()) {
        const d = !n.data.equals(value.data);
        return [d, value];
      }
      return [true, value];
    }

    switch (n.type) {
      case SHORTNODE: {
        const ml = prefixLen(key, n.key, pos);

        if (ml === n.key.length) {
          const [d, nn] = await this._insert(n.value, key, pos + ml, value);

          if (!d)
            return [false, n];

          return [true, this.shortNode(n.key, nn)];
        }

        const branch = this.fullNode();

        const [, n1] = await this._insert(NIL, n.key, ml + 1, n.value);
        const [, n2] = await this._insert(NIL, key, pos + ml + 1, value);

        branch.children[n.key[ml]] = n1;
        branch.children[key[pos + ml]] = n2;

        if (ml === 0)
          return [true, branch];

        return [true, this.shortNode(key.slice(pos, pos + ml), branch)];
      }
      case FULLNODE: {
        const c = n.children[key[pos]];
        const [d, nn] = await this._insert(c, key, pos + 1, value);

        if (!d)
          return [false, n];

        n = n.clone();
        n.children[key[pos]] = nn;
        n.flags.hash = null;
        n.flags.dirty = true;

        return [true, n];
      }
      case NULLNODE: {
        return [true, this.shortNode(key.slice(pos), value)];
      }
      case HASHNODE: {
        const rn = await this.resolveHash(n, key, pos);
        const [d, nn] = await this._insert(rn, key, pos, value);

        if (!d)
          return [false, rn];

        return [true, nn];
      }
      default: {
        throw new Error('Invalid node type.');
      }
    }
  }

  async remove(key) {
    const k = toNibbles(key);
    const [, root] = await this._remove(this.root, k, 0);

    this.root = root;
  }

  async _remove(n, key, pos) {
    assert(pos <= key.length);

    switch (n.type) {
      case SHORTNODE: {
        const ml = prefixLen(key, n.key, pos);

        if (ml < n.key.length)
          return [false, n];

        if (ml === key.length - pos)
          return [true, NIL];

        const [d, nn] = await this._remove(n.value, key, pos + n.key.length);

        if (!d)
          return [false, n];

        if (nn.isShort()) {
          const nk = concat(n.key, nn.key);
          return [true, this.shortNode(nk, nn.value)];
        }

        return [true, this.shortNode(n.key, nn)];
      }
      case FULLNODE: {
        const c = n.children[key[pos]];
        const [d, nn] = await this._remove(c, key, pos + 1);

        if (!d)
          return [false, n];

        n = n.clone();
        n.children[key[pos]] = nn;
        n.flags.hash = null;
        n.flags.dirty = true;

        let index = -1;
        for (let i = 0; i < 17; i++) {
          const child = n.children[i];
          if (!child.isNull()) {
            if (index === -1) {
              index = i;
            } else {
              index = -2;
              break;
            }
          }
        }

        if (index >= 0) {
          if (index !== 16) {
            const child = await this.resolve(n.children[index], key, index);
            if (child.isShort()) {
              const nk = concat(byte(index), child.key);
              return [true, this.shortNode(nk, child.value)];
            }
          }

          return [true, this.shortNode(byte(index), n.children[index])];
        }

        return [true, n];
      }
      case VALUENODE: {
        return [true, NIL];
      }
      case NULLNODE: {
        return [false, NIL];
      }
      case HASHNODE: {
        const rn = await this.resolveHash(n, key, pos);
        const [d, nn] = await this._remove(rn, key, pos);

        if (!d)
          return [false, rn];

        return [true, nn];
      }
      default: {
        throw new Error('Invalid node type.');
      }
    }
  }

  async resolve(n, key, index) {
    if (n.isHash()) {
      const k = concat(key, byte(index));
      const p = key.length;
      return this.resolveHash(n, k, p);
    }
    return n;
  }

  async resolveHash(n, key, pos = 0) {
    if (!this.db)
      throw new Error('Cannot resolve hash without database.');

    const raw = await this.db.get(n.data);

    if (!raw) {
      throw new MissingNodeError({
        rootHash: this.originalRoot,
        nodeHash: n.data,
        key: key,
        pos: pos
      });
    }

    return decodeNode(raw, this.hash);
  }

  iterator() {
    return new Iterator(this);
  }

  rootHash(enc) {
    const [hash, cached] = this.hashRoot(null);

    this.root = cached;

    if (enc === 'hex')
      return hash.data.toString('hex');

    return hash.data;
  }

  commit(batch, enc) {
    assert(batch);

    // Commit trie.
    const [hash, cached] = this.hashRoot(batch);

    // Write best state.
    batch.put(STATE_KEY, hash.data);

    this.originalRoot = hash.data;
    this.root = cached;
    this.cacheGen += 1;

    if (enc === 'hex')
      return hash.data.toString('hex');

    return hash.data;
  }

  hashRoot(batch) {
    if (this.root.isNull())
      return [this.hashNode(this.emptyRoot), NIL];

    const {hash, cacheGen, cacheLimit} = this;
    const hasher = new Hasher(hash, cacheGen, cacheLimit);

    return hasher.hashRoot(this.root, batch, true);
  }

  snapshot(root) {
    if (root == null)
      root = this.originalRoot;

    if (!this.db)
      throw new Error('Cannot snapshot without database.');

    const {hash, db, cacheLimit} = this;
    const trie = new this.constructor(hash, db, cacheLimit);

    return trie.inject(root);
  }

  inject(root) {
    if (root == null)
      root = this.originalRoot;

    if (typeof root === 'string')
      root = Buffer.from(root, 'hex');

    assert(Buffer.isBuffer(root));
    assert(root.length === this.hash.size);

    this.originalRoot = this.emptyRoot;
    this.root = NIL;
    this.cacheGen = 0;

    if (!root.equals(this.emptyRoot)) {
      this.originalRoot = root;
      this.root = this.hashNode(root);
    }

    return this;
  }

  async prove(root, key) {
    if (key == null) {
      key = root;
      root = this.root;
    }
    return proof.prove(this, root, key);
  }

  verify(root, key, nodes) {
    return proof.verify(this.hash, root, key, nodes);
  }
}

/*
 * Expose
 */

module.exports = Trie;
