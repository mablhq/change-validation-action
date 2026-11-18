import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  buildDescription,
  globToRegExp,
  groupByArea,
} from '../src/lib/describe.mjs';
import {oneLine} from '../src/lib/mabl-api.mjs';

const has = (haystack, needle) =>
  assert.ok(
    haystack.includes(needle),
    `missing ${JSON.stringify(needle)} in:\n${haystack.slice(0, 2000)}`,
  );
const hasNot = (haystack, needle) =>
  assert.ok(
    !haystack.includes(needle),
    `unexpected ${JSON.stringify(needle)} in:\n${haystack.slice(0, 2000)}`,
  );

const areaMap = (lines) => lines.map(([glob, phrase]) => ({glob, phrase, pattern: globToRegExp(glob)}));

const AREA_MAP = areaMap([
  ['frontend/src/checkout/**', 'checkout'],
  ['frontend/src/search/**', 'search'],
  ['frontend/**', 'frontend'],
]);

// The description with `files` grouped by AREA_MAP, unless the input brings its own groups.
const build = ({files = [], ...input}, limits) =>
  buildDescription(
    {title: 'A change', body: 'Because.', grouped: groupByArea(files.filter((file) => file !== ''), AREA_MAP), ...input},
    limits,
  );

describe('one-line text', () => {
  it('flattens a forged workflow command onto one line', () => {
    assert.equal(
      oneLine('bad\n::error::forged\r\n::add-mask::x'),
      'bad ::error::forged ::add-mask::x',
    );
  });

  it('drops format characters and takes a missing value as empty', () => {
    assert.equal(oneLine('a\u200bb\u00adc'), 'a b c');
    assert.equal(oneLine(null), '');
  });
});

describe('describe: globs', () => {
  it('holds a glob to whole path segments', () => {
    const pattern = globToRegExp('frontend/**');
    assert.equal(pattern.test('frontend/src/index.ts'), true);
    assert.equal(pattern.test('frontendx/src/index.ts'), false);
    assert.equal(pattern.test('other/frontend/src/index.ts'), false);
  });

  it('matches `**/x.snap` at the root as well as nested', () => {
    const pattern = globToRegExp('**/x.snap');
    assert.equal(pattern.test('x.snap'), true);
    assert.equal(pattern.test('frontend/x.snap'), true);
    assert.equal(pattern.test('frontend/y.snap'), false);
  });

  it('keeps a single `*` inside one segment', () => {
    const pattern = globToRegExp('*/src');
    assert.equal(pattern.test('frontend/src'), true);
    assert.equal(pattern.test('frontend/nested/src'), false);
    assert.equal(globToRegExp('*/src/**').test('frontend/a/src/x.ts'), false);
  });

  it('matches `?` against one character inside a segment', () => {
    const pattern = globToRegExp('frontend/v?.ts');
    assert.equal(pattern.test('frontend/v2.ts'), true);
    assert.equal(pattern.test('frontend/v22.ts'), false);
    assert.equal(pattern.test('frontend/v/.ts'), false);
    // One code point, not one UTF-16 unit.
    assert.equal(globToRegExp('frontend/?.ts').test('frontend/\u{1f600}.ts'), true);
  });

  it('collapses a run of stars instead of stacking quantifiers', () => {
    assert.equal(globToRegExp('frontend/***').source, globToRegExp('frontend/**').source);
    assert.equal(globToRegExp('***/x').source, globToRegExp('**/x').source);
    const started = Date.now();
    assert.equal(globToRegExp(`${'*'.repeat(40)}x`).test('a'.repeat(400)), false);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `the match took ${elapsed} ms`);
  });

  // A path git would otherwise quote and escape
  // arrives raw and has to match the area glob it belongs to.
  it('matches a path git would have quoted', () => {
    assert.equal(globToRegExp('frontend/**').test('frontend/a"b.ts'), true);
    assert.equal(globToRegExp('frontend/**').test('frontend/a\\b.ts'), true);
  });

  it('escapes a literal dot rather than matching any character', () => {
    const pattern = globToRegExp('*.snap');
    assert.equal(pattern.test('a.snap'), true);
    assert.equal(pattern.test('asnap'), false);
  });
});

describe('describe: grouping by area', () => {
  it('lets the first matching line win', () => {
    const grouped = groupByArea(['frontend/src/checkout/Cart.tsx', 'frontend/src/App.tsx'], AREA_MAP);
    assert.deepEqual(
      grouped.areas.map((area) => [area.phrase, area.count]),
      [
        ['checkout', 1],
        ['frontend', 1],
      ],
    );
    assert.equal(grouped.filesUnmapped, 0);
  });

  it('counts what nothing maps without listing it', () => {
    const grouped = groupByArea(['.github/workflows/a.yml', '.github/workflows/b.yml', 'README.md'], AREA_MAP);
    assert.deepEqual(grouped.areas, []);
    assert.equal(grouped.filesUnmapped, 3);
  });
});

describe('describe: the description', () => {
  it('carries only the PR words, the grouped paths and the totals line', () => {
    const {description} = build({
      files: ['frontend/src/Form.tsx', 'frontend/src/App.tsx'],
      diffStat: [
        ' frontend/src/Form.tsx | 2 +-',
        ' frontend/src/App.tsx  | 2 +-',
        ' 2 files changed, 1 insertion(+), 1 deletion(-)',
      ].join('\n'),
    });
    has(description, 'Title: A change');
    has(description, 'Diff stat: 2 files changed, 1 insertion(+), 1 deletion(-)');
    hasNot(description, 'unmapped');
    hasNot(description, '| 2 +-');
    assert.ok(description.indexOf('Changed paths:') < description.indexOf('Description:'));
  });

  it('counts each group and names up to the path limit', () => {
    const {description} = build(
      {
        files: Array.from({length: 10}, (_, index) => `frontend/src/checkout/R${index}.tsx`).concat(['.github/workflows/ci.yml']),
      },
      {maxPathsPerArea: 3},
    );
    has(description, 'Changed paths:');
    has(
      description,
      '- checkout (10 files): frontend/src/checkout/R0.tsx, frontend/src/checkout/R1.tsx, frontend/src/checkout/R2.tsx (+7 more)',
    );
    hasNot(description, 'unmapped');
    hasNot(description, '.github/workflows/ci.yml');
  });

  it("takes a caller's own groups and heading", () => {
    const FILES = ['frontend/a.tsx', 'frontend/b.tsx', 'frontend/c.tsx'];
    const {description} = build(
      {
        grouped: {areas: [{phrase: 'web', paths: FILES, count: 3}], filesUnmapped: 1},
        areasHeading: 'Changed paths per application:',
      },
      {maxPathsPerArea: 2},
    );
    has(description, 'Changed paths per application:\n- web (3 files): frontend/a.tsx, frontend/b.tsx (+1 more)');
    hasNot(description, 'Changed paths:\n');
  });

  it('stays inside the endpoint budget on a wide PR with a long body', () => {
    const {description, capped} = build({
      body: 'b'.repeat(30000),
      files: Array.from({length: 5000}, (_, index) => `frontend/src/f${index}.ts`),
      diffStat: Array.from({length: 5000}, (_, index) => ` frontend/src/f${index}.ts | 12 ++++++------`).join('\n'),
    });
    assert.ok(description.length <= 20000, `${description.length} units`);
    has(description, 'b'.repeat(7000));
    hasNot(description, 'b'.repeat(9000));
    // No cut needed: the per-group path cap and the totals-only diff line bound the rest by
    // construction, so only the body had to give.
    assert.equal(capped, false);
  });

  it('counts the budget in UTF-16 units and never splits a surrogate pair', () => {
    const {description, capped} = build({body: '\u{1f600}'.repeat(15000)}, {maxBodyChars: 100000});
    assert.ok(description.length <= 20000, `${description.length} units`);
    assert.equal(capped, true);
    assert.equal(/[\uD800-\uDBFF]$/.test(description), false);
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(description), false);
  });

  it('escapes a newline inside a path rather than breaking the bullet', () => {
    const {description} = build({files: ['frontend/src/a\nb.tsx'], diffStat: ''});
    has(description, '- frontend (1 file): frontend/src/a\\nb.tsx');
  });

  it("takes git's own totals line, not a filename shaped like one", () => {
    const {description} = build({
      files: ['frontend/src/Form.tsx'],
      // A legal filename, which `git diff --stat` lists above the totals it prints last.
      diffStat: [' 9999 files changed, 1 insertion(+) | 1 +', ' frontend/src/Form.tsx              | 1 +', ' 2 files changed, 2 insertions(+)'].join('\n'),
    });
    has(description, 'Diff stat: 2 files changed, 2 insertions(+)');
    hasNot(description, 'Diff stat: 9999 files changed');
  });
});
