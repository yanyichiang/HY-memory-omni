import test from 'node:test';
import assert from 'node:assert/strict';
import {wordMeasurements} from '../documents/office-measurements.mjs';
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const node = (local, attrs, uri = WORD) => ({local, uri, attributes: Object.entries(attrs).map(([local, value]) => ({local, uri, value})), children: []});
test('host converts explicit twips and half points without changing source evidence', () => {
  const original = node('pgMar', {top:'1440', header:'720'}), copy = structuredClone(original);
  assert.equal(wordMeasurements(original).top.inches, 1);
  assert.equal(wordMeasurements(original).top.points, 72);
  assert.equal(wordMeasurements(original).header.inches, .5);
  assert.deepEqual(original, copy);
  assert.equal(wordMeasurements(node('tblW', {type:'dxa', w:'6000'})).w.inches, 25 / 6);
  assert.equal(wordMeasurements(node('tcW', {type:'dxa', w:'720'})).w.inches, .5);
  assert.equal(wordMeasurements(node('gridCol', {w:'6000'})).w.type, 'initial-grid-width');
  assert.equal(wordMeasurements(node('pgSz', {w:'12240', h:'15840'}, STRICT)).w.inches, 8.5);
  assert.equal(wordMeasurements(node('sz', {val:'24'})).val.points, 12);
  assert.equal(wordMeasurements(node('szCs', {val:'28'})).val.points, 14);
  assert.equal(wordMeasurements(node('pgMar', {top:'-720'})).top.inches, -.5);
});
test('unknown units, properties, namespaces and unsafe numbers remain unresolved', () => {
  for (const value of ['pct', 'auto', 'nil', '', 'fixed']) assert.equal(wordMeasurements(node('tblW', {type:value, w:'1440'})), undefined);
  assert.equal(wordMeasurements(node('tblW', {w:'1440'})), undefined);
  assert.equal(wordMeasurements(node('unknown', {val:'1440'})), undefined);
  assert.equal(wordMeasurements(node('pgMar', {top:'1440'}, 'urn:foreign')), undefined);
  const foreignAttr = node('pgMar', {}); foreignAttr.attributes.push({local:'top', uri:'urn:foreign', value:'1440'});
  assert.equal(wordMeasurements(foreignAttr), undefined);
  foreignAttr.attributes[0].uri = ''; assert.equal(wordMeasurements(foreignAttr), undefined);
  for (const value of ['9007199254740992', 'Infinity', 'NaN', '1e3', '1.5', '1in', '', ' 720 ', '-1']) {
    assert.equal(wordMeasurements(node('gridCol', {w:value})), undefined, value);
  }
});
