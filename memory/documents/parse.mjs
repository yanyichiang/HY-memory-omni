import {wordMeasurements} from './office-measurements.mjs';
// Copyright YY. Apache-2.0. Dependencies and evidence boundaries: ./README.md.
import * as pdfLib from 'pdf-lib';
import { withPdfBudget } from './pdf-budget.mjs';
const {PDFDocument}=pdfLib;
import { Unzip, UnzipInflate } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const DOCUMENT_MIME_TYPES = Object.freeze([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const MiB = 1024 * 1024;
const NS = {
  w: ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'],
  s: ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'],
  p: ['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'],
  a: ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'],
  r: ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'],
  wp: ['http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing'],
  xdr: ['http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing', 'http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing'],
  rel: ['http://schemas.openxmlformats.org/package/2006/relationships'],
  ct: ['http://schemas.openxmlformats.org/package/2006/content-types'],
};
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false,
  parseAttributeValue: false, trimValues: false, processEntities: true, cdataPropName: '#cdata' });
const utf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
function fail(code) { throw new Error(code); }
const is = (n, ns, local) => n && NS[ns].includes(n.uri) && (!local || n.local === local);
const child = (n, ns, local) => n.children.find(c => is(c, ns, local));
const children = (n, ns, local) => n.children.filter(c => is(c, ns, local));
function descendants(n, ns, local) {
  const out = [];
  for (const c of n.children) { if (is(c, ns, local)) out.push(c); out.push(...descendants(c, ns, local)); }
  return out;
}
const attr = (n, local, ns) => n?.attributes.find(a => a.local === local && (ns ? NS[ns].includes(a.uri) : a.uri === ''))?.value;
const nodeText = n => n.text ?? n.children.map(nodeText).join('');
const plainAttrs = n => Object.fromEntries((n?.attributes ?? []).filter(a => !a.uri).map(a => [a.local, a.value]));
const issue = (kind, part, detail) => ({ kind, ...(part ? { part } : {}), ...(detail ? { detail } : {}) });

// ZIP paths and relationship targets have distinct parent-segment rules.
function normalizePath(value, allowParent = false) {
  if (typeof value !== 'string' || !value || /[\\\u0000-\u001f]/.test(value) || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) fail('document_part_path_invalid');
  const out = [];
  for (const raw of value.split('/')) {
    let p; try { p = decodeURIComponent(raw); } catch { fail('document_part_path_invalid'); }
    if (/[\\/\u0000-\u001f]/.test(p)) fail('document_part_path_invalid');
    if (p === '..') { if (!allowParent || !out.length) fail('document_part_path_invalid'); out.pop(); }
    else if (p && p !== '.') out.push(p);
  }
  if (!out.length) fail('document_part_path_invalid');
  return out.join('/');
}
function unzip(bytes) {
  const parts = new Map(); let total = 0, count = 0, failure;
  const stream = new Unzip(file => {
    try {
      if (++count > 512) fail('document_zip_part_count_exceeded');
      if (file.originalSize > 8 * MiB) fail('document_zip_expansion_exceeded');
      const path = normalizePath(file.name);
      if (parts.has(path)) fail('document_zip_duplicate_part');
      parts.set(path, undefined);
      let size = 0, chunks = [];
      file.ondata = (error, data, final) => {
        if (failure) return;
        if (error) { failure = error; return; }
        size += data.length; total += data.length;
        if (size > 8 * MiB || total > 24 * MiB) { failure = new Error('document_zip_expansion_exceeded'); file.terminate(); return; }
        chunks.push(data);
        if (final) {
          const result = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
          chunks = []; parts.set(path, result);
        }
      };
      file.start();
    } catch (error) { failure = error; file.terminate(); }
  });
  stream.register(UnzipInflate);
  // A small compressed chunk bounds each inflation callback's transient allocation.
  for (let at = 0; at < bytes.length && !failure; at += 4096) stream.push(bytes.subarray(at, at + 4096), at + 4096 >= bytes.length);
  if (failure) throw failure;
  if ([...parts.values()].some(b => !b)) fail('document_zip_incomplete');
  return parts;
}
function xml(parts, path) {
  const bytes = parts.get(path); if (!bytes) fail('document_part_missing');
  if (bytes.length > MiB) fail('document_xml_size_exceeded');
  const source = utf8.decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail('document_xml_dtd_unsupported');
  if (XMLValidator.validate(source, { allowBooleanAttributes: false }) !== true) fail('document_xml_invalid');
  // XMLValidator intentionally accepts unknown entities; OOXML has no DTD here.
  const entitySource = source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, '');
  const remaining = entitySource.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-fA-F]+|[0-9]+);/g, entity => {
    if (entity[1] === '#') {
      const hex = entity[2] === 'x', code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      if (!(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xD7FF || code >= 0xE000 && code <= 0xFFFD || code >= 0x10000 && code <= 0x10FFFF)) fail('document_xml_invalid');
    }
    return '';
  });
  if (remaining.includes('&') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) fail('document_xml_invalid');
  let count = 0;
  function bind(nodes, inherited, depth) {
    if (depth > 64) fail('document_xml_depth_exceeded');
    const result = [];
    for (const item of nodes) {
      if (++count > 65536) fail('document_xml_node_count_exceeded');
      const key = Object.keys(item).find(k => k !== ':@');
      if (key === '#text' || key === '#cdata') {
        const value = key === '#text' ? item[key] : item[key].map(n => n['#text'] ?? '').join('');
        result.push({ uri: '', local: '#text', text: String(value), attributes: [], children: [] }); continue;
      }
      if (key.startsWith('?') || key.startsWith('#')) continue;
      const rawAttrs = item[':@'] ?? {}, namespaces = new Map(inherited);
      for (const [k, v] of Object.entries(rawAttrs)) {
        if (k === '@_xmlns') { if (v === 'http://www.w3.org/2000/xmlns/' || v === 'http://www.w3.org/XML/1998/namespace') fail('document_xml_namespace_invalid'); namespaces.set('', v); }
        else if (k.startsWith('@_xmlns:')) {
          const prefix = k.slice(8);
          if (!v || prefix === 'xmlns' || v === 'http://www.w3.org/2000/xmlns/' || (prefix === 'xml') !== (v === 'http://www.w3.org/XML/1998/namespace')) fail('document_xml_namespace_invalid');
          namespaces.set(prefix, v);
        }
      }
      function expanded(qname, attribute = false) {
        const bits = qname.split(':'); if (bits.length > 2) fail('document_xml_namespace_invalid');
        const prefix = bits.length === 2 ? bits[0] : '', local = bits.at(-1);
        const uri = prefix ? namespaces.get(prefix) : attribute ? '' : namespaces.get('') ?? '';
        if (prefix && !uri || prefix === 'xmlns') fail('document_xml_namespace_invalid');
        return { uri, local };
      }
      const attributes = [], seen = new Set();
      for (const [k, value] of Object.entries(rawAttrs)) {
        if (k === '@_xmlns' || k.startsWith('@_xmlns:')) continue;
        const e = expanded(k.slice(2), true), identity = e.uri + ':' + e.local;
        if (seen.has(identity)) fail('document_xml_duplicate_attribute'); seen.add(identity);
        attributes.push({ ...e, value });
      }
      result.push({ ...expanded(key), attributes, children: bind(item[key], namespaces, depth + 1) });
    }
    return result;
  }
  const roots = bind(parser.parse(source), new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]), 0).filter(n => n.local !== '#text');
  if (roots.length !== 1) fail('document_xml_root_invalid');
  return roots[0];
}
function relationshipType(type, name) { return NS.r.some(uri => type === uri + '/' + name); }
function relationships(parts, path, coverage) {
  const slash = path.lastIndexOf('/');
  const relPath = path ? path.slice(0, slash + 1) + '_rels/' + path.slice(slash + 1) + '.rels' : '_rels/.rels';
  const result = new Map(); if (!parts.has(relPath)) return result;
  const root = xml(parts, relPath); if (!is(root, 'rel', 'Relationships')) fail('document_relationships_invalid');
  for (const n of children(root, 'rel', 'Relationship')) {
    const id = attr(n, 'Id'), target = attr(n, 'Target'), type = attr(n, 'Type');
    if (!id || !target || !type || result.has(id)) fail('document_relationships_invalid');
    if (attr(n, 'TargetMode') === 'External') { coverage.push(issue('external-relationship-not-read', path, { id, type, target })); result.set(id, { external: true, type }); continue; }
    if (attr(n, 'TargetMode') && attr(n, 'TargetMode') !== 'Internal') fail('document_relationships_invalid');
    if (/[?#]/.test(target)) fail('document_relationship_target_unsupported');
    const part = normalizePath(target.startsWith('/') && !target.startsWith('//') ? target.slice(1) : (path ? path.slice(0, slash + 1) : '') + target, true);
    if (!parts.has(part)) fail('document_relationship_part_missing');
    result.set(id, { part, type });
  }
  return result;
}
function contentTypes(parts) {
  const root = xml(parts, '[Content_Types].xml'); if (!is(root, 'ct', 'Types')) fail('document_content_types_invalid');
  const defaults = new Map(), overrides = new Map();
  for (const n of root.children) {
    if (is(n, 'ct', 'Default')) defaults.set(attr(n, 'Extension'), attr(n, 'ContentType'));
    else if (is(n, 'ct', 'Override')) overrides.set(normalizePath((attr(n, 'PartName') ?? '').replace(/^\//, '')), attr(n, 'ContentType'));
  }
  return p => overrides.get(p) ?? defaults.get(p.split('.').at(-1)) ?? 'application/octet-stream';
}
function image(parts, relation, mime, anchor, coverage, part) {
  if (!relation || relation.external) { coverage.push(issue('image-relationship-unavailable', part)); return; }
  if (!relationshipType(relation.type, 'image')) fail('document_image_relationship_invalid');
  // Declared package MIME is provenance, not a decoder-admission claim.
  return { part: relation.part, mimeType: mime(relation.part), bytes: parts.get(relation.part), anchor };
}
function limitedUnit(units, locator, context, images, coverage, derived) {
  if (units.length >= 128) fail('document_unit_count_exceeded');
  if (encoder.encode(JSON.stringify(context)).length > 65536 || encoder.encode(JSON.stringify(images.map(({ bytes, ...im }) => im))).length > 65536) fail('document_unit_context_exceeded');
  const accounted = new Set(['native-structure-not-print-pages','styles-numbering-theme-not-resolved','native-page-semantic-extraction-not-run','formula-not-recalculated-chart-theme-not-rendered','theme-master-layout-not-resolved-rendering-not-run']);
  const empty = coverage.every(c=>accounted.has(c.kind)) && !images.length && (context.blockType==='paragraph' && !context.text.trim() || context.blankPage===true || Array.isArray(context.shapes)&&context.shapes.length===0 || Array.isArray(context.cells)&&context.cells.every(c=>!c.formula&&(c.value===undefined||c.value==='')));
  units.push({ ...(empty?{empty:true}:{}), locator, context, images, coverage: { unsupported: coverage }, ...(derived ? { derived } : {}) });
}
function geometry(n) {
  if (!n) return undefined;
  return { ...plainAttrs(n), children: n.children.filter(c => c.local !== '#text').map(c => ({ kind: c.local, ...plainAttrs(c), text: nodeText(c) || undefined })) };
}
function drawingImages(n, rels, parts, mime, anchor, coverage, part) {
  const result = [];
  function visit(node, fill) {
    const current = node.local === 'blipFill' ? node : fill;
    if (is(node, 'a', 'blip')) {
      const id = attr(node, 'embed', 'r');
      if (!id) { coverage.push(issue('linked-image-not-read', part)); return; }
      const cropNode = current && child(current, 'a', 'srcRect');
      const crop = cropNode ? plainAttrs(cropNode) : undefined;
      if (crop) {
        for (const value of Object.values(crop)) if (!/^-?[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) fail('document_image_crop_invalid');
        coverage.push(issue('image-crop-not-rendered', part, { imageRelationship: id, crop }));
      }
      const display = { evidence: 'full-embedded-asset', ...(crop ? { crop, cropUnit:'one-thousandth-percent', viewportApplied:false } : {}),
        ...(current ? { fill: current.children.filter(c=>is(c,'a') && ['stretch','tile'].includes(c.local)).map(geometry) } : {}) };
      const im = image(parts, rels.get(id), mime, { ...anchor, display }, coverage, part); if (im) result.push(im);
    }
    for (const c of node.children) visit(c, current);
  }
  visit(n, undefined); return result;
}
function unsupportedRelations(rels, coverage, part, allowed) {
  for (const [id, r] of rels) if (!r.external && !allowed.some(k => relationshipType(r.type, k))) coverage.push(issue('relationship-not-interpreted', part, { id, type: r.type, target: r.part }));
}

function docx(parts, main, mime, units, totalCoverage) {
  const base = [issue('native-structure-not-print-pages', main), issue('styles-numbering-theme-not-resolved', main)];
  const rels = relationships(parts, main, base); unsupportedRelations(rels, base, main, ['image', 'styles']);
  const root = xml(parts, main); if (!is(root, 'w', 'document')) fail('document_docx_root_invalid');
  const body = child(root, 'w', 'body'); if (!body) fail('document_docx_body_missing');
  // Raw formatting evidence only: OOXML toggle properties and style precedence
  // are deliberately not evaluated into effective Word formatting.
  function property(node) {
    if (!node) return undefined;
    const measurements=wordMeasurements(node);
    return { ...(measurements?{measurements}:{}), kind: node.local, ...(NS.w.includes(node.uri) ? {} : { namespace: node.uri }), attributes: Object.fromEntries((node.attributes ?? []).map(a =>
      [!a.uri || NS.w.includes(a.uri) ? a.local : `{${a.uri}}${a.local}`, a.value])),
      ...(node.text !== undefined ? { text: node.text } : {}),
      children: node.children.filter(c => c.local !== '#text').map(property) };
  }
  const styleRelations = [...rels.values()].filter(r => !r.external && relationshipType(r.type, 'styles'));
  if (styleRelations.length > 1) fail('document_docx_styles_relationship_invalid');
  const stylePart = styleRelations[0]?.part, styleRoot = stylePart ? xml(parts, stylePart) : undefined;
  if (styleRoot && !is(styleRoot, 'w', 'styles')) fail('document_docx_styles_root_invalid');
  const styleMap = new Map(), defaultStyles = new Map();
  for (const node of styleRoot ? children(styleRoot, 'w', 'style') : []) {
    const id = attr(node, 'styleId', 'w'), type = attr(node, 'type', 'w');
    if (!id || styleMap.has(id)) fail('document_docx_style_id_invalid');
    styleMap.set(id, node);
    if (['1', 'true', 'on'].includes(attr(node, 'default', 'w'))) {
      if (defaultStyles.has(type)) fail('document_docx_style_default_invalid');
      defaultStyles.set(type, id);
    }
  }
  const defaults = property(styleRoot && child(styleRoot, 'w', 'docDefaults'));
  const sections = []; let section = 0;
  for (const block of body.children.filter(n => n.local !== '#text')) {
    const end = is(block, 'w', 'sectPr') ? block : descendants(block, 'w', 'sectPr')[0];
    if (end) { sections[section] = property(end); if (!is(block, 'w', 'sectPr')) section++; }
  }
  function styleEvidence(block, coverage) {
    const references = [];
    for (const [element, type] of [['pStyle', 'paragraph'], ['rStyle', 'character'], ['tblStyle', 'table']]) {
      for (const node of descendants(block, 'w', element)) {
        const id = attr(node, 'val', 'w'); if (id) references.push({ styleId: id, type, reference: 'explicit' });
      }
    }
    // Defaults are applicable references, not a claim that final formatting is resolved.
    for (const [element, ref, type] of [['p', 'pStyle', 'paragraph'], ['r', 'rStyle', 'character'], ['tbl', 'tblStyle', 'table']]) {
      const nodes = [...(is(block, 'w', element) ? [block] : []), ...descendants(block, 'w', element)];
      if (defaultStyles.has(type) && nodes.some(n => !descendants(n, 'w', ref).length)) references.push({ styleId: defaultStyles.get(type), type, reference: 'default' });
    }
    const used = new Map();
    for (const reference of references) {
      let id = reference.styleId; const path = new Set();
      while (id) {
        if (path.has(id)) { coverage.push(issue('docx-style-cycle-not-resolved', stylePart ?? main, { styleId: id })); break; }
        path.add(id);
        const node = styleMap.get(id);
        if (!node) { coverage.push(issue('docx-style-reference-missing', stylePart ?? main, { styleId: id })); break; }
        if (used.has(id)) break;
        const parent = attr(child(node, 'w', 'basedOn'), 'val', 'w');
        used.set(id, { styleId: id, type: attr(node, 'type', 'w'), basedOn: parent, definition: property(node) });
        if (parent && styleMap.has(parent) && attr(styleMap.get(parent), 'type', 'w') !== attr(node, 'type', 'w')) {
          coverage.push(issue('docx-style-base-type-mismatch-not-resolved', stylePart, { styleId: id, basedOn: parent }));
        }
        id = parent;
      }
    }
    return { ...(stylePart ? { part: stylePart } : {}), resolved: false,
      note: 'Raw OOXML formatting and referenced style definitions; toggle/inheritance, theme, numbering and conditional table rules are not computed. Hidden/strike formatting is not an authenticated revision.',
      ...(defaults ? { docDefaults: defaults } : {}), references, styles: [...used.values()] };
  }
  let blockIndex = 0, sectionIndex = 0;
  function paragraph(n) {
    const segments = [], runs = [];
    function visit(node, runIndex) {
      if (is(node, 'w', 'pPr') || is(node, 'w', 'rPr')) return;
      if (is(node, 'w', 'r')) {
        runIndex = runs.length;
        const pr = child(node, 'w', 'rPr');
        runs.push({ runIndex, properties: property(pr), styleId: attr(pr && child(pr, 'w', 'rStyle'), 'val', 'w') });
      }
      let segment;
      if (is(node, 'w', 't')) segment = { kind: 'text', text: nodeText(node) };
      else if (is(node, 'w', 'tab')) segment = { kind: 'tab', text: '\t' };
      else if (is(node, 'w', 'noBreakHyphen')) segment = { kind: 'text', text: '\u2011' };
      else if (is(node, 'w', 'softHyphen')) segment = { kind: 'text', text: '\u00ad' };
      else if (is(node, 'w', 'br') || is(node, 'w', 'cr')) segment = { kind: 'break', text: '\n', type: attr(node, 'type', 'w') };
      if (segment) segments.push({ ...segment, ...(runIndex === undefined ? {} : { runIndex }) });
      else for (const c of node.children) visit(c, runIndex);
    }
    visit(n);
    return { text: segments.map(s => s.text).join(''), segments, runs, paragraphProperties: property(child(n, 'w', 'pPr')),
      styleId: attr(child(child(n, 'w', 'pPr') ?? { children: [] }, 'w', 'pStyle'), 'val', 'w') };
  }
  for (const n of body.children.filter(n => n.local !== '#text')) {
    if (is(n, 'w', 'sectPr')) continue;
    const coverage = [...base], images = [];
    const locator = { kind: 'docx-block', part: main, blockIndex: blockIndex++, sectionIndex };
    let context;
    if (is(n, 'w', 'p')) context = { blockType: 'paragraph', ...paragraph(n) };
    else if (is(n, 'w', 'tbl')) {
      const rows = children(n, 'w', 'tr').map((tr, rowIndex) => {
        const rowPr = child(tr, 'w', 'trPr') ?? { children: [] };
        let columnIndex = Number(attr(child(rowPr, 'w', 'gridBefore'), 'val', 'w') ?? 0);
        if (!Number.isSafeInteger(columnIndex) || columnIndex < 0 || columnIndex > 16384) fail('document_table_span_invalid');
        return { rowIndex, properties: property(rowPr), cells: children(tr, 'w', 'tc').map(tc => {
          const pr = child(tc, 'w', 'tcPr') ?? { children: [] };
          const span = Number(attr(child(pr, 'w', 'gridSpan'), 'val', 'w') ?? 1);
          if (!Number.isSafeInteger(span) || span < 1 || span > 16384) fail('document_table_span_invalid');
          const cell = { rowIndex, columnIndex, columnSpan: span, properties: property(pr), verticalMerge: attr(child(pr, 'w', 'vMerge'), 'val', 'w') ?? (child(pr, 'w', 'vMerge') ? 'continue' : undefined),
            paragraphs: children(tc, 'w', 'p').map(paragraph) };
          columnIndex += span; return cell;
        }) };
      });
      context = { blockType: 'table', rows, tableProperties: property(child(n, 'w', 'tblPr')),
        gridColumns: children(child(n, 'w', 'tblGrid') ?? { children: [] }, 'w', 'gridCol').map(c => ({ widthTwips: attr(c, 'w', 'w') })) };
      if (descendants(n, 'w', 'tbl').length) coverage.push(issue('nested-table-not-interpreted', main));
    } else { totalCoverage.push(issue('docx-block-not-interpreted', main, { blockIndex: locator.blockIndex, kind: n.local, namespace: n.uri })); continue; }
    context.formatting = styleEvidence(n, coverage);
    if (sections[sectionIndex]) context.sectionProperties = sections[sectionIndex];
    let drawingIndex = 0;
    const drawingEntries = context.blockType === 'table'
      ? children(n, 'w', 'tr').flatMap((tr, ri) => children(tr, 'w', 'tc').flatMap((tc, ci) => descendants(tc, 'w', 'drawing').map(d => ({ d, rowIndex: ri, columnIndex: context.rows[ri].cells[ci].columnIndex }))))
      : descendants(n, 'w', 'drawing').map(d => ({ d }));
    for (const { d, rowIndex, columnIndex } of drawingEntries) {
      const anchorNode = child(d, 'wp', 'anchor') ?? child(d, 'wp', 'inline');
      const anchor = { kind: anchorNode?.local ?? 'drawing', drawingIndex: drawingIndex++, blockIndex: locator.blockIndex, rowIndex, columnIndex,
        attributes: plainAttrs(anchorNode), extent: geometry(anchorNode && child(anchorNode, 'wp', 'extent')),
        positionH: geometry(anchorNode && child(anchorNode, 'wp', 'positionH')), positionV: geometry(anchorNode && child(anchorNode, 'wp', 'positionV')) };
      images.push(...drawingImages(d, rels, parts, mime, anchor, coverage, main));
    }
    for (const k of ['pict', 'object', 'altChunk', 'footnoteReference', 'endnoteReference', 'del', 'ins']) if (descendants(n, 'w', k).length) coverage.push(issue('docx-' + k + '-not-interpreted', main));
    limitedUnit(units, locator, context, images, coverage);
    if (descendants(n, 'w', 'sectPr').length) sectionIndex++;
  }
  totalCoverage.push(...base);
}

function cellPosition(ref) {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref ?? ''); if (!m) fail('document_cell_reference_invalid');
  let column = 0; for (const c of m[1]) column = column * 26 + c.charCodeAt(0) - 64;
  const row = Number(m[2]); if (column > 16384 || row > 1048576) fail('document_cell_reference_invalid'); return { row, column };
}
function columnName(column) { let result = ''; for (; column; column = Math.floor((column - 1) / 26)) result = String.fromCharCode(65 + (column - 1) % 26) + result; return result; }
const rangeName = r => columnName(r.c1) + r.r1 + ':' + columnName(r.c2) + r.r2;
function parseRange(ref) { const pieces = (ref ?? '').split(':'); if (pieces.length > 2) fail('document_cell_range_invalid'); const [a, b = a] = pieces; const p = cellPosition(a), q = cellPosition(b); if (p.row > q.row || p.column > q.column) fail('document_cell_range_invalid'); return { r1: p.row, c1: p.column, r2: q.row, c2: q.column }; }
const intersects = (a, b) => a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
// Preserve property provenance without claiming that fonts/themes/cascades were rendered.
function rawProperties(node) {
  if (!node) return undefined;
  return { kind: node.local, namespace: node.uri, attributes: node.attributes,
    ...(node.text === undefined ? {} : { text: node.text }), children: node.children.map(rawProperties) };
}
function sheetString(node) {
  if (!node) return undefined;
  // Phonetic guides are annotations, not additional cell text.
  return { text: node.children.filter(n => is(n, 's', 't') || is(n, 's', 'r')).map(n =>
    is(n, 's', 't') ? nodeText(n) : children(n, 's', 't').map(nodeText).join('')).join(''), properties: rawProperties(node) };
}
function spreadsheet(parts, main, mime, units, totalCoverage) {
  const base = [issue('native-structure-not-print-pages', main), issue('formula-not-recalculated-chart-theme-not-rendered', main)];
  const rels = relationships(parts, main, base); unsupportedRelations(rels, base, main, ['worksheet', 'sharedStrings', 'styles']);
  const root = xml(parts, main); if (!is(root, 's', 'workbook')) fail('document_xlsx_root_invalid');
  const workbookProperties = plainAttrs(child(root,'s','workbookPr'));
  if(workbookProperties.date1904!==undefined && !['0','1','true','false'].includes(workbookProperties.date1904))fail('document_date_system_invalid');
  const dateSystem=['1','true'].includes(workbookProperties.date1904)?'1904':'1900';
  function related(kind) { return [...rels.values()].find(r => relationshipType(r.type, kind))?.part; }
  const sharedPart = related('sharedStrings');
  const sharedRoot = sharedPart ? xml(parts, sharedPart) : undefined;
  if (sharedRoot && !is(sharedRoot, 's', 'sst')) fail('document_shared_strings_root_invalid');
  const shared = sharedRoot ? children(sharedRoot, 's', 'si').map(sheetString) : [];
  const stylePart = related('styles'), stylesRoot = stylePart ? xml(parts, stylePart) : undefined;
  if (stylesRoot && !is(stylesRoot, 's', 'styleSheet')) fail('document_styles_root_invalid');
  const styleItems = (container, item) => stylesRoot ? children(child(stylesRoot, 's', container) ?? { children: [] }, 's', item) : [];
  const styles = styleItems('cellXfs', 'xf'), baseStyles = styleItems('cellStyleXfs', 'xf');
  const resources = { fontId: styleItems('fonts', 'font'), fillId: styleItems('fills', 'fill'), borderId: styleItems('borders', 'border') };
  function styleDefinition(id, coverage) {
    function reference(items, value, kind) {
      if (!/^[0-9]+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || !items[Number(value)]) {
        coverage.push(issue('spreadsheet-style-reference-missing', stylePart ?? main, { kind, id: value })); return;
      }
      return items[Number(value)];
    }
    const node = reference(styles, id, 'cellXf'); if (!node) return { id };
    const baseId = attr(node, 'xfId'), base = baseId === undefined ? undefined : reference(baseStyles, baseId, 'cellStyleXf');
    const dependencies = [];
    for (const [kind, items] of Object.entries(resources)) {
      for (const value of new Set([attr(node, kind), attr(base, kind)].filter(v => v !== undefined))) {
        const resource = reference(items, value, kind); if (resource) dependencies.push({ kind, id: value, properties: rawProperties(resource) });
      }
    }
    return { id, definition: plainAttrs(node), properties: rawProperties(node),
      ...(base ? { baseStyle: { id: baseId, properties: rawProperties(base) } } : {}), resources: dependencies };
  }
  const formats = stylesRoot ? descendants(stylesRoot, 's', 'numFmt').map(plainAttrs) : [];
  let sheetIndex = 0;
  for (const sheet of descendants(root, 's', 'sheet')) {
    const sheetRel = rels.get(attr(sheet, 'id', 'r')); if (!sheetRel?.part || !relationshipType(sheetRel.type, 'worksheet')) fail('document_worksheet_relationship_invalid');
    const part = sheetRel.part, tree = xml(parts, part); if (!is(tree, 's', 'worksheet')) fail('document_worksheet_root_invalid');
    const coverage = [...base], sr = relationships(parts, part, coverage); unsupportedRelations(sr, coverage, part, ['image', 'drawing']);
    for (const kind of ['conditionalFormatting', 'tableParts', 'autoFilter', 'extLst']) if (children(tree, 's', kind).length) coverage.push(issue('spreadsheet-' + kind + '-not-evaluated', part));
    const cells = [], seen = new Set();
    for (const n of descendants(tree, 's', 'c')) {
      const ref = attr(n, 'r'), pos = cellPosition(ref); if (seen.has(ref)) fail('document_cell_duplicate'); seen.add(ref);
      const type = attr(n, 't') ?? 'n', v = child(n, 's', 'v'), f = child(n, 's', 'f');
      let value = v ? nodeText(v) : undefined, richText;
      if (type === 's') { const index = Number(value); if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(index) || shared[index] === undefined) fail('document_shared_string_invalid'); value = shared[index].text; richText = shared[index].properties; }
      if (type === 'inlineStr') { const inline = sheetString(child(n, 's', 'is')); value = inline?.text ?? ''; richText = inline?.properties; }
      cells.push({ ref, ...pos, type, styleId: attr(n, 's'), ...(richText ? { richText } : {}), ...(f ? { formula: { text: nodeText(f), ...plainAttrs(f) }, cachedValue: value } : { value }) });
    }
    const merges = descendants(tree, 's', 'mergeCell').map(n => ({ ref: attr(n, 'ref'), bounds: parseRange(attr(n, 'ref')) }));
    const rows = descendants(tree, 's', 'row').map(plainAttrs), columns = descendants(tree, 's', 'col').map(plainAttrs), images = [];
    for (const drawing of descendants(tree, 's', 'drawing')) {
      const relation = sr.get(attr(drawing, 'id', 'r')); if (!relation?.part) fail('document_drawing_relationship_invalid');
      const drCoverage = [], dr = relationships(parts, relation.part, drCoverage); coverage.push(...drCoverage); unsupportedRelations(dr, coverage, relation.part, ['image']);
      const drawingRoot = xml(parts, relation.part); if (!is(drawingRoot, 'xdr', 'wsDr')) fail('document_drawing_root_invalid');
      for (const a of drawingRoot.children.filter(n => n.local !== '#text')) {
        function marker(kind) {
          const m = child(a, 'xdr', kind); if (!m) return undefined;
          const values = Object.fromEntries(m.children.filter(c => is(c, 'xdr')).map(c => [c.local, nodeText(c)]));
          for (const key of ['row', 'col']) if (!/^\d+$/.test(values[key] ?? '')) fail('document_image_anchor_invalid');
          const row = Number(values.row) + 1, column = Number(values.col) + 1; cellPosition(columnName(column) + row);
          return { row, column, rowOffsetEmu: values.rowOff ?? '0', columnOffsetEmu: values.colOff ?? '0' };
        }
        const from = marker('from'), to = marker('to');
        let bounds;
        if (from) bounds = { r1: from.row, c1: from.column, r2: to?.row ?? from.row, c2: to?.column ?? from.column };
        if (bounds && (bounds.r2 < bounds.r1 || bounds.c2 < bounds.c1)) fail('document_image_anchor_invalid');
        const anchor = { kind: a.local, from, to, extent: geometry(child(a, 'xdr', 'ext')), position: geometry(child(a, 'xdr', 'pos')), bounds };
        // A one-cell extent or absolute anchor cannot be converted to cells without layout.
        if (!to) coverage.push(issue('image-cell-extent-unresolved', part, { anchorKind: a.local }));
        images.push(...drawingImages(a, dr, parts, mime, anchor, coverage, part));
        if (descendants(a, 'a', 'graphicData').length) coverage.push(issue('drawing-chart-not-interpreted', part));
      }
    }
    const buckets = new Map();
    function bucket(row, column) {
      const r = Math.floor((row - 1) / 32) * 32 + 1, c = Math.floor((column - 1) / 16) * 16 + 1, key = r + ':' + c;
      if (!buckets.has(key)) { if (buckets.size >= 128) fail('document_unit_count_exceeded'); buckets.set(key, { r1: r, c1: c, r2: Math.min(r + 31, 1048576), c2: Math.min(c + 15, 16384) }); }
    }
    for (const c of cells) bucket(c.row, c.column);
    for (const im of images) if (im.anchor.bounds) bucket(im.anchor.bounds.r1, im.anchor.bounds.c1);
    if (!buckets.size) bucket(1, 1);
    function emit(bounds) {
      const selected = cells.filter(c => c.row >= bounds.r1 && c.row <= bounds.r2 && c.column >= bounds.c1 && c.column <= bounds.c2);
      const selectedRows = rows.filter(r => Number(r.r) >= bounds.r1 && Number(r.r) <= bounds.r2);
      const selectedColumns = columns.filter(c => Number(c.min) <= bounds.c2 && Number(c.max) >= bounds.c1);
      const unitCoverage = [...coverage];
      const styleIds = new Set([...selected.map(c => c.styleId ?? (styles.length ? '0' : undefined)), ...selectedRows.map(r => r.s), ...selectedColumns.map(c => c.style)].filter(id => id !== undefined));
      const context = { workbookProperties, dateSystem, dateSerialNote:'Numeric values remain original serials. Apply the specified workbook date system and number format; 1900 serial 60 is the legacy fictitious leap day. No formula recalculation has run.', cells: selected, merges: merges.filter(m => intersects(m.bounds, bounds)),
        rows: selectedRows, columns: selectedColumns, sheetProperties: plainAttrs(sheet),
        layout: ['sheetFormatPr', 'sheetViews', 'pageMargins', 'pageSetup', 'printOptions'].map(k => rawProperties(child(tree, 's', k))).filter(Boolean),
        formatting: { resolved: false, note: 'Referenced raw cell/base styles, fonts, fills, borders and rich text. Apply flags, row/column precedence, theme and conditional formatting are not evaluated; no print layout or formula recalculation.' },
        styles: [...styleIds].map(id => styleDefinition(id, unitCoverage)), numberFormats: formats };
      // Split dense ranges until the native context fits, without truncating cells.
      if (encoder.encode(JSON.stringify(context)).length > 65536) {
        if (bounds.r1 < bounds.r2) { const mid = Math.floor((bounds.r1 + bounds.r2) / 2); emit({ ...bounds, r2: mid }); emit({ ...bounds, r1: mid + 1 }); return; }
        if (bounds.c1 < bounds.c2) { const mid = Math.floor((bounds.c1 + bounds.c2) / 2); emit({ ...bounds, c2: mid }); emit({ ...bounds, c1: mid + 1 }); return; }
        fail('document_unit_context_exceeded');
      }
      // Unresolved pixel/cell extents attach to every range so no image is silently lost.
      const relevant = images.filter(im => !im.anchor.to || !im.anchor.bounds || intersects(im.anchor.bounds, bounds));
      limitedUnit(units, { kind: 'xlsx-range', part, sheetIndex, sheetName: attr(sheet, 'name'), range: rangeName(bounds) }, context, relevant, unitCoverage);
    }
    for (const b of [...buckets.values()].sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1)) emit(b);
    totalCoverage.push(...coverage); sheetIndex++;
  }
  totalCoverage.push(...base);
}

function presentation(parts, main, mime, units, totalCoverage) {
  const base = [issue('theme-master-layout-not-resolved-rendering-not-run', main)], rels = relationships(parts, main, base);
  unsupportedRelations(rels, base, main, ['slide']);
  const root = xml(parts, main); if (!is(root, 'p', 'presentation')) fail('document_pptx_root_invalid');
  let slideIndex = 0;
  for (const slide of descendants(root, 'p', 'sldId')) {
    const r = rels.get(attr(slide, 'id', 'r')); if (!r?.part || !relationshipType(r.type, 'slide')) fail('document_slide_relationship_invalid');
    const part = r.part, coverage = [...base], sr = relationships(parts, part, coverage); unsupportedRelations(sr, coverage, part, ['image']);
    const tree = xml(parts, part); if (!is(tree, 'p', 'sld')) fail('document_slide_root_invalid');
    const shapeTree = descendants(tree, 'p', 'spTree')[0]; if (!shapeTree) fail('document_slide_shapes_missing');
    const images = [];
    function shapes(parent, parentPath = []) {
      return parent.children.filter(n => is(n, 'p') && !['nvGrpSpPr', 'grpSpPr', 'extLst'].includes(n.local)).map((n, zOrder) => {
        const shapePath = [...parentPath, zOrder];
        const shapeProperties = child(n, 'p', is(n, 'p', 'grpSp') ? 'grpSpPr' : 'spPr');
        const transform = shapeProperties && child(shapeProperties, 'a', 'xfrm');
        function paragraphText(node) {
          if (is(node, 'a', 't')) return nodeText(node);
          if (is(node, 'a', 'br')) return '\n';
          if (is(node, 'a', 'tab')) return '\t';
          return node.children.map(paragraphText).join('');
        }
        const textBody = child(n, 'p', 'txBody');
        const paragraphs = textBody ? children(textBody, 'a', 'p') : is(n, 'p', 'grpSp') ? [] : descendants(n, 'a', 'p');
        const text = paragraphs.map(paragraphText);
        const info = { kind: n.local, zOrder, shapePath, id: attr(descendants(n, 'p', 'cNvPr')[0], 'id'),
          name: attr(descendants(n, 'p', 'cNvPr')[0], 'name'), transform: geometry(transform), paragraphs: text,
          nonVisual: rawProperties(n.children.find(c => is(c, 'p') && c.local.startsWith('nv'))),
          shapeProperties: rawProperties(shapeProperties), style: rawProperties(child(n, 'p', 'style')),
          ...(is(n, 'p', 'graphicFrame') ? { tables: descendants(n, 'a', 'tbl').map(rawProperties) } : {}),
          textLayout: textBody ? { bodyProperties: rawProperties(child(textBody, 'a', 'bodyPr')), listStyle: rawProperties(child(textBody, 'a', 'lstStyle')),
            paragraphs: paragraphs.map(paragraph => ({ text: paragraphText(paragraph), properties: rawProperties(paragraph) })) } : undefined };
        if (is(n, 'p', 'grpSp')) info.children = shapes(n, shapePath);
        else images.push(...drawingImages(n, sr, parts, mime, { shapePath, zOrder, transform: info.transform }, coverage, part));
        if (!['sp', 'pic', 'grpSp', 'cxnSp'].includes(n.local)) coverage.push(issue('presentation-shape-not-interpreted', part, { kind: n.local, shapePath }));
        return info;
      });
    }
    limitedUnit(units, { kind: 'pptx-slide', part, slideIndex: slideIndex++ }, { size: plainAttrs(child(root, 'p', 'sldSz')), slideProperties: plainAttrs(tree),
      background: rawProperties(child(child(tree, 'p', 'cSld') ?? { children: [] }, 'p', 'bg')),
      formatting: { resolved: false, note: 'Direct shape/text formatting and local geometry only. Theme/master/layout inheritance, group-to-page transforms, font metrics, line wrapping and pixel rendering are not computed.' }, shapes: shapes(shapeTree) }, images, coverage);
    totalCoverage.push(...coverage);
  }
}

/** Parses original evidence; performs no fetches, model calls, rendering or formula recalculation. */
export async function parseDocument(mimeType, bytes) {
  if (!DOCUMENT_MIME_TYPES.includes(mimeType)) fail('document_mime_unsupported');
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 8 * MiB) fail('document_source_size_exceeded');
  const units = [], coverage = [];
  if (mimeType === 'application/pdf') {
    units.push(...await splitDerivedOfficePdf(bytes));
  } else {
    const parts = unzip(bytes), mime = contentTypes(parts), rootCoverage = [], rels = relationships(parts, '', rootCoverage);
    const roots = [...rels.values()].filter(r => !r.external && relationshipType(r.type, 'officeDocument'));
    if (roots.length !== 1) fail('document_package_root_invalid');
    const main = roots[0].part;
    if (mimeType === DOCUMENT_MIME_TYPES[1]) docx(parts, main, mime, units, coverage);
    else if (mimeType === DOCUMENT_MIME_TYPES[2]) spreadsheet(parts, main, mime, units, coverage);
    else presentation(parts, main, mime, units, coverage);
    coverage.push(...rootCoverage);
  }
  if (!units.length) fail('document_no_supported_units');
  // Keep each unit self-describing as well as the document-wide coverage summary.
  const summary = [...coverage, ...units.flatMap(u => u.coverage.unsupported)];
  const unique = new Map(summary.map(c => [JSON.stringify(c), c]));
  return { original: { mimeType, bytes }, units, coverage: { unsupported: [...unique.values()] } };
}

/** Recognize actual package root content type, never a filename extension. */
export function documentMime(bytes) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>8*MiB)fail('document_source_size_exceeded');
  if(new TextDecoder('latin1').decode(bytes.subarray(0,1024)).includes('%PDF-'))return DOCUMENT_MIME_TYPES[0];
  if(bytes[0]!==80||bytes[1]!==75)return undefined;
  const parts=unzip(bytes),mime=contentTypes(parts),rels=relationships(parts,'',[]);
  const roots=[...rels.values()].filter(r=>!r.external&&relationshipType(r.type,'officeDocument'));
  if(roots.length!==1)fail('document_package_root_invalid');
  const type=mime(roots[0].part);
  const types=['application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'];
  const index=types.indexOf(type);if(index<0)fail('document_package_type_unsupported');return DOCUMENT_MIME_TYPES[index+1];
}

// Renderer preflight reuses the original-evidence ZIP/XML admission limits.
export function officePackageParts(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 8 * MiB) fail('document_source_size_exceeded');
  return unzip(bytes);
}
export const officeXml = xml;

/** Internal renderer PDF splitting: bounded derived output is distinct from original-source admission. */
export async function splitDerivedOfficePdf(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 16 * MiB) fail('document_derived_size_exceeded');
  const units=[];
    if(pdfLib.HY_PDF_BOUNDED!==true)fail('document_pdf_bounded_build_required');
    await withPdfBudget(async()=>{
    const doc = await PDFDocument.load(bytes,{throwOnInvalidObject:true}); if (!doc.getPageCount() || doc.getPageCount() > 128) fail('document_unit_count_exceeded');
    let total = 0;
    for (let pageIndex = 0; pageIndex < doc.getPageCount(); pageIndex++) {
      const page = doc.getPage(pageIndex), d = await PDFDocument.create(); d.addPage((await d.copyPages(doc, [pageIndex]))[0]);
      const pageBytes = await d.save(); total += pageBytes.length; if (total > 16 * MiB) fail('document_derived_size_exceeded');
      const c = [issue('native-page-semantic-extraction-not-run')];
      limitedUnit(units, { kind: 'pdf-page', pageIndex }, { size: page.getSize(), rotation: page.getRotation().angle, blankPage:!page.node.Contents()&&!page.node.Annots() }, [], c, { mimeType: 'application/pdf', bytes: pageBytes });
    }
    });
  return units;
}
