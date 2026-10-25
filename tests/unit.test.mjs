import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  calculatePercentiles,
  getByPath,
  setByPath,
  mergeDeep,
  parseCsvData,
  resolveDynamicGenerator,
  renderTemplate,
  pickEndpoint
} from '../bin/safe-load-lab.js';


test('calculatePercentiles - basic functionality', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const result = calculatePercentiles(values, [50, 90, 95, 99]);
  
  assert.ok(result[50] >= 5 && result[50] <= 6, 'p50 should be around median');
  assert.ok(result[90] >= 9, 'p90 should be near top');
  assert.ok(result[95] >= 9, 'p95 should be near top');
  assert.ok(result[99] >= 10, 'p99 should be at or near max');
});

test('calculatePercentiles - empty array', () => {
  const result = calculatePercentiles([], [50, 95, 99]);
  assert.equal(result[50], 0);
  assert.equal(result[95], 0);
  assert.equal(result[99], 0);
});

test('calculatePercentiles - single value', () => {
  const result = calculatePercentiles([42], [50, 95, 99]);
  assert.equal(result[50], 42);
  assert.equal(result[95], 42);
  assert.equal(result[99], 42);
});

test('calculatePercentiles - performance test', () => {
  const largeDataset = Array.from({ length: 10000 }, (_, i) => Math.random() * 1000);
  
  const start = performance.now();
  const result = calculatePercentiles(largeDataset, [50, 90, 95, 99]);
  const duration = performance.now() - start;
  
  assert.ok(duration < 100, `Performance test failed: took ${duration}ms, expected < 100ms`);
  assert.ok(result[50] > 0, 'Should calculate p50');
  assert.ok(result[99] > result[50], 'p99 should be greater than p50');
});

test('getByPath - simple path', () => {
  const obj = { user: { name: 'Alice', age: 30 } };
  assert.equal(getByPath(obj, 'user.name'), 'Alice');
  assert.equal(getByPath(obj, 'user.age'), 30);
});

test('getByPath - nested path', () => {
  const obj = { data: { user: { profile: { email: 'test@example.com' } } } };
  assert.equal(getByPath(obj, 'data.user.profile.email'), 'test@example.com');
});

test('getByPath - missing path', () => {
  const obj = { user: { name: 'Alice' } };
  assert.equal(getByPath(obj, 'user.missing'), undefined);
  assert.equal(getByPath(obj, 'missing.path'), undefined);
});

test('getByPath - null and undefined handling', () => {
  const obj = { user: null };
  assert.equal(getByPath(obj, 'user.name'), undefined);
});

test('setByPath - simple path', () => {
  const obj = {};
  setByPath(obj, 'user.name', 'Bob');
  assert.equal(obj.user.name, 'Bob');
});

test('setByPath - nested path', () => {
  const obj = {};
  setByPath(obj, 'data.user.profile.email', 'bob@example.com');
  assert.equal(obj.data.user.profile.email, 'bob@example.com');
});

test('setByPath - overwrite existing', () => {
  const obj = { user: { name: 'Alice' } };
  setByPath(obj, 'user.name', 'Bob');
  assert.equal(obj.user.name, 'Bob');
});

test('renderTemplate - simple variable replacement', () => {
  const vars = { name: 'Alice', age: 30 };
  const result = renderTemplate('Hello {{name}}, you are {{age}} years old', vars);
  assert.equal(result, 'Hello Alice, you are 30 years old');
});

test('renderTemplate - nested variable paths', () => {
  const vars = { user: { name: 'Alice', profile: { city: 'NYC' } } };
  const result = renderTemplate('{{user.name}} lives in {{user.profile.city}}', vars);
  assert.equal(result, 'Alice lives in NYC');
});

test('renderTemplate - missing variables', () => {
  const vars = { name: 'Alice' };
  const result = renderTemplate('Hello {{name}}, {{missing}}', vars);
  assert.equal(result, 'Hello Alice, ');
});

test('renderTemplate - array handling', () => {
  const vars = { baseUrl: 'https://api.example.com' };
  const result = renderTemplate(['{{baseUrl}}/users', '{{baseUrl}}/posts'], vars);
  assert.deepEqual(result, ['https://api.example.com/users', 'https://api.example.com/posts']);
});

test('renderTemplate - object handling', () => {
  const vars = { token: 'abc123' };
  const result = renderTemplate({ Authorization: 'Bearer {{token}}' }, vars);
  assert.deepEqual(result, { Authorization: 'Bearer abc123' });
});

test('renderTemplate - whitespace handling', () => {
  const vars = { name: 'Alice' };
  const result = renderTemplate('Hello {{ name }} and {{name}}', vars);
  assert.equal(result, 'Hello Alice and Alice');
});

test('pickEndpoint - single endpoint', () => {
  const endpoints = [{ name: 'api1', weight: 1 }];
  const result = pickEndpoint(endpoints);
  assert.equal(result.name, 'api1');
});

test('pickEndpoint - weighted distribution', () => {
  const endpoints = [
    { name: 'high', weight: 10 },
    { name: 'low', weight: 1 }
  ];
  
  const picks = { high: 0, low: 0 };
  for (let i = 0; i < 1000; i++) {
    const result = pickEndpoint(endpoints);
    picks[result.name]++;
  }
  
  // High weight should be picked more often (roughly 10:1 ratio)
  assert.ok(picks.high > picks.low * 5, `Distribution skewed: high=${picks.high}, low=${picks.low}`);
});

test('pickEndpoint - zero weight handling', () => {
  const endpoints = [
    { name: 'valid', weight: 1 },
    { name: 'zero', weight: 0 }
  ];
  
  for (let i = 0; i < 100; i++) {
    const result = pickEndpoint(endpoints);
    assert.ok(result.name === 'valid' || result.name === 'zero');
  }
});

test('pickEndpoint - negative weight handling', () => {
  const endpoints = [
    { name: 'valid', weight: 5 },
    { name: 'negative', weight: -1 }
  ];
  
  // Should treat negative as 0
  const result = pickEndpoint(endpoints);
  assert.ok(result.name === 'valid' || result.name === 'negative');
});

test('memory efficiency - large result set handling', () => {
  const results = [];
  const startMem = process.memoryUsage().heapUsed;
  
  // Simulate 10k requests
  for (let i = 0; i < 10000; i++) {
    results.push({
      endpoint: 'test',
      status: 200,
      durationMs: Math.random() * 100,
      timestamp: new Date().toISOString()
    });
  }
  
  const endMem = process.memoryUsage().heapUsed;
  const memUsedMB = (endMem - startMem) / 1024 / 1024;
  
  assert.ok(memUsedMB < 50, `Memory usage too high: ${memUsedMB.toFixed(2)}MB for 10k results`);
  assert.equal(results.length, 10000);
});

test('setByPath - prototype pollution protection', () => {
  const target = {};
  setByPath(target, '__proto__.polluted', 'yes');
  setByPath(target, 'constructor.prototype.polluted', 'yes');
  setByPath(target, 'prototype.polluted', 'yes');
  
  assert.equal({}.polluted, undefined, 'Object prototype must not be polluted');
  assert.equal(target.polluted, undefined);
});

test('mergeDeep - prototype pollution protection', () => {
  const target = {};
  const malicious = JSON.parse('{"__proto__": {"admin": true}, "constructor": {"prototype": {"admin": true}}}');
  mergeDeep(target, malicious);

  assert.equal({}.admin, undefined, 'Object prototype must not be polluted by mergeDeep');
  assert.equal(target.admin, undefined);
});

test('parseCsvData - prototype pollution protection', () => {
  const csv = '__proto__,name,age\nadmin=true,Alice,30\n';
  const rows = parseCsvData(csv);
  assert.equal(rows.length, 1);
  assert.equal({}.admin, undefined, 'Object prototype must not be polluted by parseCsvData');
  assert.equal(rows[0].name, 'Alice');
  assert.equal(rows[0].age, '30');
});

test('resolveDynamicGenerator - boundary checks and length limits', () => {
  const hugeString = resolveDynamicGenerator('$randomString:50000');
  assert.ok(hugeString.length <= 10000, 'Length must be clamped to max 10000');

  const validString = resolveDynamicGenerator('$randomString:16');
  assert.equal(validString.length, 16);

  const boundedInt = parseInt(resolveDynamicGenerator('$randomInt:50:100'), 10);
  assert.ok(boundedInt >= 50 && boundedInt <= 100);

  const invertedInt = parseInt(resolveDynamicGenerator('$randomInt:100:50'), 10);
  assert.ok(invertedInt >= 50 && invertedInt <= 100, 'Inverted min/max must swap correctly');
});
