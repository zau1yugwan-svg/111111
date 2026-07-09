figma.showUI(__html__, { width: 380, height: 720, themeColors: true });

const DEFAULT_GAP = 96;

postSelectionState();
figma.on('selectionchange', postSelectionState);

figma.ui.onmessage = async (message) => {
  if (message.type === 'close') {
    figma.closePlugin();
    return;
  }

  if (message.type === 'load-settings') {
    figma.ui.postMessage({
      type: 'settings',
      settings: {
        provider: normalizeProvider(await readSetting('provider')),
        endpoint: await readSetting('endpoint'),
        apiKey: await readSetting('apiKey'),
        region: await readSetting('region'),
        email: await readSetting('email'),
        targetLanguage: normalizeTargetLanguage(await readSetting('targetLanguage'))
      }
    });
    return;
  }

  if (message.type === 'save-translation-settings') {
    const settings = message.settings || {};
    await writeSetting('provider', normalizeProvider(settings.provider));
    await writeSetting('endpoint', settings.endpoint || '');
    await writeSetting('apiKey', settings.apiKey || '');
    await writeSetting('region', settings.region || '');
    await writeSetting('email', settings.email || '');
    await writeSetting('targetLanguage', normalizeTargetLanguage(settings.targetLanguage));
    figma.ui.postMessage({ type: 'settings-saved', ok: true });
    return;
  }

  if (message.type === 'reset-translation-settings') {
    await writeSetting('provider', 'mymemory');
    await writeSetting('endpoint', '');
    await writeSetting('apiKey', '');
    await writeSetting('region', '');
    await writeSetting('email', '');
    await writeSetting('targetLanguage', 'ar');
    figma.ui.postMessage({ type: 'settings-reset', ok: true });
    return;
  }

  if (message.type !== 'convert') return;

  const settings = message.settings || {};
  const mode = settings.mode === 'translate-only' ? 'translate-only' : 'mirror';

  const selection = getSelectedConvertibleSources();
  if (!selection.length) {
    figma.notify('请先选中一个或多个画板 / 元素');
    figma.ui.postMessage({ type: 'done', ok: false });
    postSelectionState();
    return;
  }

  try {
    const converted = [];
    const clonePlacement = settings.createCopy ? createClonePlacement(selection) : null;
    const stats = {
      skippedTextCount: 0,
      skippedFonts: {}
    };
    for (const source of selection) {
      let target = settings.createCopy ? cloneBeside(source, clonePlacement) : source;
      target = detachInstances(target);
      if (settings.createCopy) {
        target.name = source.name + (mode === 'translate-only' ? ' - AR' : ' - AR RTL');
      }

      const result = await convertNode(target, settings);
      mergeConversionStats(stats, result);
      converted.push(target);
    }

    figma.currentPage.selection = converted;
    figma.viewport.scrollAndZoomIntoView(converted);
    const summary = buildDoneSummary(converted.length, stats);
    figma.notify(summary);
    figma.ui.postMessage({ type: 'done', ok: true, summary: summary });
    postSelectionState();
  } catch (error) {
    const detail = getErrorDetail(error);
    figma.notify('转换失败：' + detail.message);
    figma.ui.postMessage({ type: 'done', ok: false, error: detail.message, detail: detail.detail });
    postSelectionState();
  }
};

function getErrorDetail(error) {
  const message = error && error.message ? error.message : String(error || '未知错误');
  const stack = error && error.stack ? String(error.stack) : '';
  return {
    message: message,
    detail: stack ? stack.split('\n').slice(0, 6).join('\n') : message
  };
}

function postSelectionState() {
  const selected = getSelectedConvertibleSources();
  figma.ui.postMessage({
    type: 'selection',
    count: selected.length,
    items: selected.map(function (node) {
      return {
        id: node.id,
        name: node.name || '(未命名画板)',
        type: node.type
      };
    })
  });
}

function getSelectedConvertibleSources() {
  const result = [];
  const seen = {};
  for (const node of figma.currentPage.selection) {
    const source = getEditableSource(node);
    if (!source || seen[source.id]) continue;
    seen[source.id] = true;
    result.push(source);
  }
  return result;
}

async function readSetting(key) {
  try {
    return await figma.clientStorage.getAsync(key) || '';
  } catch (error) {
    return '';
  }
}

async function writeSetting(key, value) {
  try {
    await figma.clientStorage.setAsync(key, value);
  } catch (error) {
    // Development plugins can run without storage access; conversion should still work.
  }
}

function createClonePlacement(nodes) {
  if (!nodes.length) return { dx: 0 };
  let minX = Infinity;
  let maxX = -Infinity;

  for (const node of nodes) {
    if (!('x' in node) || !('width' in node)) continue;
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x + node.width);
  }

  if (minX === Infinity || maxX === -Infinity) return { dx: 0 };
  return { dx: maxX - minX + DEFAULT_GAP };
}

function cloneBeside(node, placement) {
  const clone = node.clone();

  const parent = canAppendTo(node.parent) ? node.parent : figma.currentPage;
  if (clone.parent !== parent) {
    parent.appendChild(clone);
  }

  if ('x' in clone && 'width' in node) {
    const dx = placement && typeof placement.dx === 'number'
      ? placement.dx
      : node.width + DEFAULT_GAP;
    trySet(clone, 'x', node.x + dx);
  }
  if ('y' in clone) trySet(clone, 'y', node.y);
  return clone;
}

function canAppendTo(parent) {
  return parent && parent.type !== 'INSTANCE' && !isInsideInstance(parent);
}

function getEditableSource(node) {
  const instance = findContainingInstance(node);
  return instance || findContainingTopLevelNode(node) || node;
}

function findContainingTopLevelNode(node) {
  let current = node;
  let topLevel = node;
  while (current && current.parent && current.parent.type !== 'PAGE') {
    if (current.parent.type === 'SECTION') break;
    topLevel = current.parent;
    current = current.parent;
  }
  return topLevel;
}

function findContainingInstance(node) {
  let current = node;
  while (current) {
    if (current.type === 'INSTANCE') return current;
    current = current.parent;
  }
  return null;
}

function isInsideInstance(node) {
  let current = node;
  while (current) {
    if (current.type === 'INSTANCE') return true;
    current = current.parent;
  }
  return false;
}

function detachInstances(node) {
  let target = node;
  if (target.type === 'INSTANCE') {
    target = target.detachInstance();
  }

  if ('children' in target) {
    const children = target.children.slice();
    for (const child of children) {
      detachInstances(child);
    }
  }

  return target;
}

async function convertNode(root, settings) {
  const stats = await translateTexts(root, settings);
  if (settings.mirror !== false) {
    mirrorContainer(root, true);
  }
  return stats;
}

async function translateTexts(node, settings) {
  const textNodes = [];
  collectTextNodes(node, textNodes);
  const loadedTextNodes = [];
  const stats = {
    skippedTextCount: 0,
    skippedFonts: {}
  };

  for (const textNode of textNodes) {
    const result = await tryLoadTextFonts(textNode);
    if (result.ok) {
      loadedTextNodes.push(textNode);
    } else {
      stats.skippedTextCount += 1;
      if (result.fontKey) {
        stats.skippedFonts[result.fontKey] = true;
      }
    }
  }

  let translations = {};
  if (settings.translate) {
    translations = await buildTranslationMap(loadedTextNodes, settings);
  }
  if (settings.mirror !== false && settings.translate) {
    addMirrorTextRunTransforms(loadedTextNodes, translations);
  }

  for (const textNode of loadedTextNodes) {
    applyTextUpdate(textNode, translations, settings);
  }

  return stats;
}

function addMirrorTextRunTransforms(textNodes, translations) {
  for (const node of textNodes) {
    const text = String(node.characters || '');
    if (!text || translations[text]) continue;
    const mirrored = mirrorTextRuns(text);
    if (mirrored !== text) {
      translations[text] = mirrored;
    }
  }
}

function mirrorTextRuns(text) {
  const runs = String(text || '').match(/[\u3400-\u9fff]+|[A-Za-z0-9]+|\s+|[^\u3400-\u9fffA-Za-z0-9\s]+/g);
  if (!runs || runs.length < 2) return text;
  if (!runs.some(containsChinese)) return text;
  if (!runs.some(function (run) { return /[A-Za-z0-9]/.test(run); })) return text;
  return runs.reverse().join('');
}

function mergeConversionStats(total, next) {
  if (!next) return;
  total.skippedTextCount += next.skippedTextCount || 0;
  const fonts = next.skippedFonts || {};
  for (const fontKey in fonts) {
    total.skippedFonts[fontKey] = true;
  }
}

function buildDoneSummary(count, stats) {
  let summary = '已处理 ' + count + ' 个对象';
  if (stats && stats.skippedTextCount) {
    const fonts = Object.keys(stats.skippedFonts || {});
    summary += '，有 ' + stats.skippedTextCount + ' 个文本因字体缺失未翻译';
    if (fonts.length) {
      summary += '：' + fonts.slice(0, 3).join('、');
      if (fonts.length > 3) summary += ' 等';
    }
  }
  return summary;
}

function collectTextNodes(node, result) {
  if (node.type === 'TEXT') {
    result.push(node);
    return;
  }
  if ('children' in node) {
    for (const child of node.children) {
      collectTextNodes(child, result);
    }
  }
}

async function buildTranslationMap(textNodes, settings) {
  const uniqueTexts = [];
  const seen = {};
  const translations = {};
  const table = settings.translationTable || {};
  if (settings.tableImported && settings.tableTargetMissing) {
    return translations;
  }
  const hasTable = !!settings.useTranslationTable && Object.keys(table).length > 0;
  for (const node of textNodes) {
    const text = String(node.characters || '');
    if (!normalizeTextForTranslation(text)) continue;

    const styledSegmentTranslation = await buildStyledSegmentTranslation(node, settings, table, hasTable);
    if (styledSegmentTranslation) {
      translations[node.id] = styledSegmentTranslation;
      continue;
    }

    if (seen[text]) continue;
    seen[text] = true;

    const localText = transformLocalText(text);
    if (localText !== text) {
      translations[text] = localText;
      continue;
    }

    if (hasTable) {
      const tableText = getTableTranslation(table, text);
      if (tableText) {
        translations[text] = buildExactTableTranslation(text, tableText, settings.mirror !== false);
        continue;
      }

      const tableRunTranslation = translateTextRunsFromTable(text, table, settings.mirror !== false);
      if (tableRunTranslation) {
        translations[text] = tableRunTranslation;
        continue;
      }
    }

    if (!containsChinese(text)) continue;
    if (hasTable && !settings.fallbackMissingWithMyMemory) continue;
    uniqueTexts.push(text);
  }

  if (!uniqueTexts.length) return translations;

  if (hasTable && settings.fallbackMissingWithMyMemory) {
    const remoteTranslations = {};
    for (const text of uniqueTexts) {
      remoteTranslations[text] = await translateWithMyMemory(text, settings);
    }
    return mergeStyledTranslations(translations, remoteTranslations);
  }

  if (normalizeProvider(settings.provider) === 'custom') {
    const remoteTranslations = await translateTextBatch(uniqueTexts, settings);
    return mergeStyledTranslations(translations, remoteTranslations);
  }

  for (const text of uniqueTexts) {
    translations[text] = await translateText(text, settings);
  }
  return styleTranslationValues(translations, uniqueTexts);
}

function getTableTranslation(table, text) {
  if (!table) return '';
  if (table[text]) return table[text];
  const trimmed = String(text || '').trim();
  return table[trimmed] || '';
}

async function buildStyledSegmentTranslation(node, settings, table, hasTable) {
  const text = String(node.characters || '');
  const segments = captureFillSegments(node).filter(function (segment) {
    return segment.text;
  });
  if (segments.length < 2 || !segments.some(function (segment) { return containsChinese(segment.text); })) {
    return null;
  }

  let translatedAny = false;
  const parts = [];
  for (const segment of segments) {
    const translatedText = await translateStyledSegmentText(segment.text, settings, table, hasTable);
    if (translatedText !== segment.text) translatedAny = true;
    parts.push({
      text: translatedText,
      sourceStart: segment.start,
      sourceEnd: segment.end
    });
  }
  if (!translatedAny && settings.mirror === false) return null;

  const outputParts = shouldMirrorPartOrder(parts, settings.mirror !== false)
    ? parts.slice().reverse()
    : parts;
  return buildTranslationFromSourceParts(outputParts);
}

async function translateStyledSegmentText(text, settings, table, hasTable) {
  const localText = transformLocalText(text);
  if (localText !== text) return localText;
  if (!containsChinese(text)) return text;

  if (hasTable) {
    const tableText = getTableTranslation(table, text);
    if (tableText) return tableText;

    const tableRunTranslation = translateTextRunsFromTable(text, table, false);
    if (tableRunTranslation) return tableRunTranslation.text;

    if (!settings.fallbackMissingWithMyMemory) return text;
  }

  return await translateText(text, settings);
}

function buildTranslationFromSourceParts(parts) {
  let cursor = 0;
  const stylePlan = parts.map(function (part) {
    const start = cursor;
    cursor += part.text.length;
    return {
      start: start,
      end: cursor,
      sourceStart: part.sourceStart,
      sourceEnd: part.sourceEnd
    };
  });
  return {
    text: parts.map(function (part) { return part.text; }).join(''),
    stylePlan: stylePlan
  };
}

function translateTextRunsFromTable(text, table, mirror) {
  if (!table || !text) return null;
  const sourceRuns = getTextRuns(text);
  if (!sourceRuns.length) return null;
  let translatedAny = false;
  const outputRuns = sourceRuns.map(function (run) {
    const translated = containsChinese(run.text)
      ? getTableTranslation(table, run.text)
      : '';
    if (translated) translatedAny = true;
    return {
      sourceStart: run.start,
      sourceEnd: run.end,
      text: translated || run.text
    };
  });
  if (!translatedAny) return null;
  if (mirror) outputRuns.reverse();
  const textOut = outputRuns.map(function (run) { return run.text; }).join('');
  if (textOut === text) return null;

  let cursor = 0;
  const stylePlan = outputRuns.map(function (run) {
    const start = cursor;
    cursor += run.text.length;
    return {
      start: start,
      end: cursor,
      sourceStart: run.sourceStart,
      sourceEnd: run.sourceEnd
    };
  });

  return {
    text: textOut,
    stylePlan: stylePlan
  };
}

function buildExactTableTranslation(sourceText, translatedText, mirror) {
  const targetRuns = getTextRuns(translatedText).map(function (run) {
    return {
      text: run.text
    };
  });
  if (shouldMirrorPartOrder(targetRuns, mirror)) targetRuns.reverse();

  const outputText = targetRuns.length
    ? targetRuns.map(function (run) { return run.text; }).join('')
    : String(translatedText || '');
  const stylePlan = buildStylePlanByRunAffinity(sourceText, targetRuns, outputText);
  return {
    text: outputText,
    stylePlan: stylePlan
  };
}

function shouldMirrorPartOrder(parts, mirror) {
  if (!mirror) return false;
  if (partsContainRtlText(parts) && partsContainAlphaNumericText(parts)) return false;
  return true;
}

function partsContainRtlText(parts) {
  return parts.some(function (part) {
    return containsRtlText(part.text);
  });
}

function partsContainAlphaNumericText(parts) {
  return parts.some(function (part) {
    return /[A-Za-z0-9]/.test(part.text || '');
  });
}

function containsRtlText(value) {
  return /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/.test(value || '');
}

function buildStylePlanByRunAffinity(sourceText, targetRuns, outputText) {
  const sourceRuns = getTextRuns(sourceText);
  if (!sourceRuns.length || !targetRuns.length) return [];

  const used = new Array(sourceRuns.length).fill(false);
  let cursor = 0;
  return targetRuns.map(function (run) {
    const start = cursor;
    cursor += run.text.length;
    const sourceIndex = findSourceRunForTarget(run.text, sourceRuns, used);
    if (sourceIndex >= 0) used[sourceIndex] = true;
    const sourceRun = sourceIndex >= 0 ? sourceRuns[sourceIndex] : sourceRuns[0];
    return {
      start: start,
      end: cursor,
      sourceStart: sourceRun.start,
      sourceEnd: sourceRun.end
    };
  }).filter(function (item) {
    return item.start < item.end && item.end <= outputText.length;
  });
}

function findSourceRunForTarget(targetText, sourceRuns, used) {
  const exact = findUnusedSourceRun(sourceRuns, used, function (run) {
    return run.text === targetText;
  });
  if (exact >= 0) return exact;

  const targetType = getRunType(targetText);
  if (targetType === 'translated') {
    const chinese = findUnusedSourceRun(sourceRuns, used, function (run) {
      return containsChinese(run.text);
    });
    if (chinese >= 0) return chinese;
  }

  const sameType = findUnusedSourceRun(sourceRuns, used, function (run) {
    return getRunType(run.text) === targetType;
  });
  if (sameType >= 0) return sameType;

  return findUnusedSourceRun(sourceRuns, used, function () {
    return true;
  });
}

function findUnusedSourceRun(sourceRuns, used, predicate) {
  for (let i = 0; i < sourceRuns.length; i += 1) {
    if (!used[i] && predicate(sourceRuns[i])) return i;
  }
  return -1;
}

function getRunType(text) {
  if (containsChinese(text)) return 'chinese';
  if (/[A-Za-z0-9]/.test(text)) return 'alnum';
  if (/^\s+$/.test(text)) return 'space';
  if (/^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？、；：“”‘’（）【】《》…·]+$/.test(text)) return 'punct';
  return 'translated';
}

function mergeStyledTranslations(base, extra) {
  for (const key in extra) {
    base[key] = buildExactTableTranslation(key, extra[key], false);
  }
  return base;
}

function styleTranslationValues(translations, keys) {
  for (const key of keys) {
    if (translations[key]) {
      translations[key] = buildExactTableTranslation(key, translations[key], false);
    }
  }
  return translations;
}

function normalizeTextForTranslation(value) {
  return String(value || '').trim();
}

function transformLocalText(value) {
  return applyPreTranslationTextRules(value);
}

function applyPreTranslationTextRules(value) {
  let text = String(value || '');
  text = transformChineseDateTime(text);
  text = transformSignedDecimalMarks(text);
  return text;
}

function transformChineseDateTime(value) {
  return String(value || '').replace(
    /(\d{4})[年\/.-](\d{1,2})[月\/.-](\d{1,2})日?\s+(\d{1,2})([:：\/])(\d{1,2})(?:([:：\/])(\d{1,2}))?/g,
    function (_match, year, month, day, hour, timeSep1, minute, timeSep2, second) {
      const date = pad2(day) + '/' + pad2(month) + '/' + year;
      let time = pad2(hour) + timeSep1 + pad2(minute);
      if (second !== undefined) {
        time += (timeSep2 || timeSep1) + pad2(second);
      }
      return time + ' ' + date;
    }
  ).replace(
    /(\d{4})[年\/.-](\d{1,2})[月\/.-](\d{1,2})日?/g,
    function (_match, year, month, day) {
      return pad2(day) + '/' + pad2(month) + '/' + year;
    }
  );
}

function transformSignedDecimalMarks(value) {
  return String(value || '').replace(/(^|[^\d.])([+-])(\d+\.\d+%?)/g, function (_match, prefix, sign, number) {
    return prefix + number + sign;
  });
}

function pad2(value) {
  const text = String(value);
  return text.length === 1 ? '0' + text : text;
}

function applyTextUpdate(node, translations, settings) {
  const text = String(node.characters || '');
  const value = translations[node.id] || translations[text];
  if (text && value) {
    const translation = normalizeTranslationValue(value);
    setCharactersPreservingFillStyles(node, translation.text, translation.stylePlan);
  }

  if (settings.mirror !== false && node.textAlignHorizontal === 'LEFT') {
    trySet(node, 'textAlignHorizontal', 'RIGHT');
  }
}

function normalizeTranslationValue(value) {
  if (value && typeof value === 'object') {
    return {
      text: String(value.text || ''),
      stylePlan: Array.isArray(value.stylePlan) ? value.stylePlan : []
    };
  }
  return {
    text: String(value || ''),
    stylePlan: []
  };
}

function setCharactersPreservingFillStyles(node, nextText, stylePlan) {
  const previousText = String(node.characters || '');
  const segments = captureFillSegments(node);
  const plannedSegments = stylePlan && stylePlan.length
    ? materializeStylePlan(stylePlan, segments)
    : planMovedFillSegments(previousText, String(nextText || ''), segments);
  node.characters = nextText;
  restoreFillSegments(node, previousText, String(nextText || ''), segments, plannedSegments);
}

function captureFillSegments(node) {
  try {
    if (typeof node.getStyledTextSegments === 'function') {
      return node.getStyledTextSegments(['fills']).map(function (segment) {
        return {
          start: segment.start,
          end: segment.end,
          text: segment.characters || '',
          fills: cloneValue(segment.fills)
        };
      }).filter(function (segment) {
        return segment.fills && segment.fills !== figma.mixed;
      });
    }
  } catch (error) {
    // Older Figma runtimes can fail here; fallback below keeps conversion running.
  }

  const fills = safeGet(node, 'fills');
  if (!fills || fills === figma.mixed) return [];
  return [{
    start: 0,
    end: String(node.characters || '').length,
    text: String(node.characters || ''),
    fills: cloneValue(fills)
  }];
}

function restoreFillSegments(node, previousText, nextText, segments, plannedSegments) {
  if (!segments.length || !nextText) return;

  const used = new Array(nextText.length).fill(false);
  const matchedSegments = [];
  if (plannedSegments && plannedSegments.length) {
    for (const planned of plannedSegments) {
      setRangeFillsSafe(node, planned.start, planned.end, planned.fills);
      markRangeUsed(used, planned.start, planned.end);
      matchedSegments.push({
        start: planned.start,
        end: planned.end,
        segment: planned
      });
    }
  }

  const unmatchedSegments = [];
  for (const segment of segments) {
    if (!segment.text || !segment.fills) continue;
    const range = findUnusedTextRange(nextText, segment.text, used);
    if (!range) {
      unmatchedSegments.push(segment);
      continue;
    }
    setRangeFillsSafe(node, range.start, range.end, segment.fills);
    markRangeUsed(used, range.start, range.end);
    matchedSegments.push({
      start: range.start,
      end: range.end,
      segment: segment
    });
  }

  const fallbackSegments = unmatchedSegments.length ? unmatchedSegments : segments;
  const unusedRanges = getUnusedRanges(used);
  for (let i = 0; i < unusedRanges.length; i += 1) {
    const range = unusedRanges[i];
    const sourceSegment = pickStyleSegmentForRange(range, matchedSegments, fallbackSegments);
    if (sourceSegment && sourceSegment.fills) {
      setRangeFillsSafe(node, range.start, range.end, sourceSegment.fills);
    }
  }
}

function planMovedFillSegments(previousText, nextText, segments) {
  const previousRuns = getTextRuns(previousText);
  const nextRuns = getTextRuns(nextText);
  if (previousRuns.length < 2 || previousRuns.length !== nextRuns.length) return [];

  const reversedPreviousRuns = previousRuns.slice().reverse();
  for (let i = 0; i < nextRuns.length; i += 1) {
    if (nextRuns[i].text !== reversedPreviousRuns[i].text) return [];
  }

  const planned = [];
  for (let i = 0; i < nextRuns.length; i += 1) {
    const sourceRun = reversedPreviousRuns[i];
    const segment = findSegmentCoveringRange(segments, sourceRun.start, sourceRun.end);
    if (!segment || !segment.fills) continue;
    planned.push({
      start: nextRuns[i].start,
      end: nextRuns[i].end,
      text: nextRuns[i].text,
      fills: segment.fills
    });
  }
  return planned;
}

function materializeStylePlan(stylePlan, segments) {
  const planned = [];
  for (const item of stylePlan) {
    const segment = findSegmentCoveringRange(segments, item.sourceStart, item.sourceEnd);
    if (!segment || !segment.fills || item.start >= item.end) continue;
    planned.push({
      start: item.start,
      end: item.end,
      text: '',
      fills: segment.fills
    });
  }
  return planned;
}

function getTextRuns(text) {
  const result = [];
  const regex = /[\u3400-\u9fff]+|[A-Za-z0-9]+|\s+|[^\u3400-\u9fffA-Za-z0-9\s]+/g;
  let match;
  while ((match = regex.exec(String(text || '')))) {
    result.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return result;
}

function findSegmentCoveringRange(segments, start, end) {
  return segments.find(function (segment) {
    return segment.start <= start && segment.end >= end;
  }) || null;
}

function pickStyleSegmentForRange(range, matchedSegments, fallbackSegments) {
  for (const matched of matchedSegments) {
    if (matched.start >= range.end) return matched.segment;
  }
  return fallbackSegments[0] || null;
}

function findUnusedTextRange(text, needle, used) {
  let start = text.indexOf(needle);
  while (start >= 0) {
    const end = start + needle.length;
    let available = true;
    for (let i = start; i < end; i += 1) {
      if (used[i]) {
        available = false;
        break;
      }
    }
    if (available) return { start: start, end: end };
    start = text.indexOf(needle, start + 1);
  }
  return null;
}

function markRangeUsed(used, start, end) {
  for (let i = start; i < end; i += 1) used[i] = true;
}

function getUnusedRanges(used) {
  const ranges = [];
  let start = -1;
  for (let i = 0; i <= used.length; i += 1) {
    if (i < used.length && !used[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      ranges.push({ start: start, end: i });
      start = -1;
    }
  }
  return ranges;
}

function setRangeFillsSafe(node, start, end, fills) {
  if (start >= end || !fills || fills === figma.mixed) return;
  try {
    node.setRangeFills(start, end, cloneValue(fills));
  } catch (error) {
    // Preserve text content even if a specific range style cannot be restored.
  }
}

function cloneValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return value;
  }
}

async function loadTextFonts(node) {
  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName);
    return;
  }

  const fonts = new Map();
  for (let i = 0; i < node.characters.length; i += 1) {
    const font = node.getRangeFontName(i, i + 1);
    if (font !== figma.mixed) {
      fonts.set(font.family + '::' + font.style, font);
    }
  }

  for (const font of fonts.values()) {
    await figma.loadFontAsync(font);
  }
}

async function tryLoadTextFonts(node) {
  try {
    await loadTextFonts(node);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      fontKey: getMissingFontKey(error, node)
    };
  }
}

function getMissingFontKey(error, node) {
  const message = error && error.message ? String(error.message) : '';
  const match = message.match(/The font \"([^\"]+)\" could not be loaded/);
  if (match) return match[1];
  if (node.fontName && node.fontName !== figma.mixed) {
    return node.fontName.family + ' ' + node.fontName.style;
  }
  return '未知字体';
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/.test(value);
}

async function translateText(text, settings) {
  const provider = normalizeProvider(settings.provider);
  if (provider === 'mymemory') {
    return await translateWithMyMemory(text, settings);
  }
  if (provider === 'none') {
    return text;
  }
  return await translateWithCustomEndpoint(text, settings);
}

async function translateTextBatch(texts, settings) {
  const endpoint = (settings.endpoint || '').trim();
  if (!endpoint) {
    const fallback = {};
    for (const text of texts) fallback[text] = text;
    return fallback;
  }

  const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);
  const headers = {
    'Content-Type': 'application/json'
  };
  if (settings.apiKey) {
    headers.Authorization = 'Bearer ' + settings.apiKey;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      q: texts,
      text: texts,
      texts: texts,
      source: 'zh',
      source_lang: 'ZH',
      target: targetLanguage,
      target_lang: targetLanguage.toUpperCase(),
      format: 'text',
      api_key: settings.apiKey || undefined,
      auth_key: settings.apiKey || undefined
    })
  });

  if (!response.ok) {
    throw new Error('翻译接口返回 ' + response.status);
  }

  const data = await response.json();
  return normalizeBatchTranslationResult(texts, data);
}

function normalizeBatchTranslationResult(texts, data) {
  const result = {};
  const values = extractTranslatedValues(data);
  for (let i = 0; i < texts.length; i += 1) {
    result[texts[i]] = values[i] || texts[i];
  }
  return result;
}

function extractTranslatedValues(data) {
  if (Array.isArray(data)) {
    return data.map(extractOneTranslatedValue);
  }
  if (Array.isArray(data.translations)) {
    return data.translations.map(extractOneTranslatedValue);
  }
  if (Array.isArray(data.translatedText)) return data.translatedText;
  if (Array.isArray(data.translation)) return data.translation;
  if (Array.isArray(data.text)) return data.text;
  if (Array.isArray(data.result)) return data.result;

  const single = extractOneTranslatedValue(data);
  return single ? [single] : [];
}

function extractOneTranslatedValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.translatedText) return value.translatedText;
  if (value.translation) return value.translation;
  if (value.text) return value.text;
  if (value.result) return value.result;
  if (value.translations && value.translations[0]) {
    return extractOneTranslatedValue(value.translations[0]);
  }
  return '';
}

function normalizeProvider(value) {
  if (value === 'custom' || value === 'none') return value;
  return 'mymemory';
}

function normalizeTargetLanguage(value) {
  return String(value || 'ar').trim() || 'ar';
}

async function translateWithMyMemory(text, settings) {
  const email = (settings.email || '').trim();
  const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);
  let url = 'https://api.mymemory.translated.net/get?q='
    + encodeURIComponent(text)
    + '&langpair='
    + encodeURIComponent('zh-CN|' + targetLanguage);
  if (email) {
    url += '&de=' + encodeURIComponent(email);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('MyMemory 翻译接口返回 ' + response.status);
  }

  const data = await response.json();
  if (data.responseData && data.responseData.translatedText) {
    return data.responseData.translatedText;
  }
  if (data.matches && data.matches[0] && data.matches[0].translation) {
    return data.matches[0].translation;
  }
  return text;
}

async function translateWithCustomEndpoint(text, settings) {
  const endpoint = (settings.endpoint || '').trim();
  if (!endpoint) return text;

  const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);
  const headers = {
    'Content-Type': 'application/json'
  };
  if (settings.apiKey) {
    headers.Authorization = 'Bearer ' + settings.apiKey;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      q: text,
      text,
      source: 'zh',
      source_lang: 'ZH',
      target: targetLanguage,
      target_lang: targetLanguage.toUpperCase(),
      format: 'text',
      api_key: settings.apiKey || undefined,
      auth_key: settings.apiKey || undefined
    })
  });

  if (!response.ok) {
    throw new Error('翻译接口返回 ' + response.status);
  }

  const data = await response.json();
  if (Array.isArray(data.translations) && data.translations[0] && data.translations[0].text) {
    return data.translations[0].text;
  }
  return data.translatedText || data.translation || data.text || data.result || text;
}

function mirrorContainer(node, isRoot) {
  if (!('children' in node)) return;
  if (node.type === 'GROUP') {
    node = replaceGroupWithFrame(node);
  }

  const vectorArtwork = !isRoot && isVectorArtworkContainer(node);

  let children = node.children.slice();
  if (!vectorArtwork) {
    for (const child of children) {
      mirrorContainer(child, false);
    }
    children = node.children.slice();
  }

  mirrorAutoLayout(node, { preserveVectorLayerOrder: vectorArtwork });
  if ('width' in node && !vectorArtwork) {
    mirrorChildrenPositions(node, children);
  }

  if (!isRoot) {
    swapConstraints(node);
  }
  swapDirectionalRadii(node);
  swapDirectionalStrokes(node);
}

function replaceGroupWithFrame(group) {
  const parent = group.parent;
  if (!parent || !('insertChild' in parent)) return group;

  const frame = figma.createFrame();
  frame.name = group.name;
  frame.x = group.x;
  frame.y = group.y;
  frame.resize(group.width, group.height);
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ('opacity' in group) trySet(frame, 'opacity', group.opacity);
  if ('visible' in group) trySet(frame, 'visible', group.visible);
  if ('layoutPositioning' in group && 'layoutPositioning' in frame) {
    trySet(frame, 'layoutPositioning', group.layoutPositioning);
  }

  const index = parent.children.indexOf(group);
  parent.insertChild(index, frame);

  const groupX = group.x || 0;
  const groupY = group.y || 0;
  for (const child of group.children.slice()) {
    const childX = 'x' in child ? child.x : 0;
    const childY = 'y' in child ? child.y : 0;
    frame.appendChild(child);
    if ('x' in child) trySet(child, 'x', childX - groupX);
    if ('y' in child) trySet(child, 'y', childY - groupY);
  }

  safeRemove(group);
  return frame;
}

function safeRemove(node) {
  try {
    if (node && !node.removed) {
      node.remove();
    }
  } catch (error) {
    // Moving every child out of a group can make Figma remove the empty group for us.
  }
}

function isVectorArtworkContainer(node) {
  if (!('children' in node) || !node.children.length) return false;
  const width = safeGet(node, 'width');
  const height = safeGet(node, 'height');
  if (typeof width === 'number' && typeof height === 'number' && Math.max(width, height) > 240) {
    return false;
  }
  const result = scanVectorArtwork(node);
  return result.hasVector && !result.hasNonVector;
}

function scanVectorArtwork(node) {
  if (!('children' in node) || !node.children.length) {
    return {
      hasVector: isVectorLeaf(node),
      hasNonVector: !isVectorLeaf(node)
    };
  }

  let hasVector = false;
  let hasNonVector = false;
  for (const child of node.children) {
    const childResult = scanVectorArtwork(child);
    hasVector = hasVector || childResult.hasVector;
    hasNonVector = hasNonVector || childResult.hasNonVector;
  }

  return {
    hasVector: hasVector,
    hasNonVector: hasNonVector
  };
}

function isVectorLeaf(node) {
  return node.type === 'VECTOR'
    || node.type === 'BOOLEAN_OPERATION'
    || node.type === 'LINE'
    || node.type === 'POLYGON'
    || node.type === 'STAR'
    || node.type === 'RECTANGLE'
    || node.type === 'ELLIPSE';
}

function mirrorAutoLayout(node, options) {
  if (!('layoutMode' in node)) return;
  if (node.layoutMode === 'NONE') return;

  const preserveVectorLayerOrder = options && options.preserveVectorLayerOrder;
  mirrorAutoLayoutHorizontalPadding(node);
  if (node.layoutMode === 'HORIZONTAL' && 'children' in node) {
    if (!preserveVectorLayerOrder) {
      reverseChildOrder(node);
    }
    if ('primaryAxisAlignItems' in node) {
      trySet(node, 'primaryAxisAlignItems', swapAxisAlign(node.primaryAxisAlignItems));
    }
  }

  if (node.layoutMode === 'VERTICAL' && 'counterAxisAlignItems' in node) {
    trySet(node, 'counterAxisAlignItems', swapAxisAlign(node.counterAxisAlignItems));
  }
}

function mirrorChildrenPositions(parent, children) {
  const isAutoLayout = parent.layoutMode && parent.layoutMode !== 'NONE';
  const parentWidth = safeGet(parent, 'width');
  if (typeof parentWidth !== 'number') return;

  for (const child of children) {
    if (!child || child.removed) continue;
    const childX = safeGet(child, 'x');
    const childWidth = safeGet(child, 'width');
    if (typeof childX !== 'number' || typeof childWidth !== 'number') continue;
    if (isAutoLayout && safeGet(child, 'layoutPositioning') !== 'ABSOLUTE') continue;
    if (isRotatedImageFillNode(child)) continue;
    trySet(child, 'x', parentWidth - childX - childWidth);
    swapConstraints(child);
  }
}

function safeGet(node, key) {
  try {
    return node[key];
  } catch (error) {
    return undefined;
  }
}

function isRotatedImageFillNode(node) {
  if (!('fills' in node) || !('rotation' in node)) return false;
  const rotation = safeGet(node, 'rotation');
  const fills = safeGet(node, 'fills');
  if (typeof rotation !== 'number' || Math.abs(rotation) < 0.01) return false;
  if (!fills || fills === figma.mixed) return false;

  for (const paint of fills) {
    if (paint.type === 'IMAGE') return true;
  }
  return false;
}

function mirrorAutoLayoutHorizontalPadding(node) {
  if (!('paddingLeft' in node) || !('paddingRight' in node)) return;
  const left = node.paddingLeft;
  const right = node.paddingRight;
  trySet(node, 'paddingLeft', right);
  trySet(node, 'paddingRight', left);
}

function reverseChildOrder(node) {
  const reversedChildren = node.children.slice().reverse();
  for (const child of reversedChildren) {
    try {
      node.appendChild(child);
    } catch (error) {
      return false;
    }
  }
  return true;
}

function swapAxisAlign(value) {
  if (value === 'MIN') return 'MAX';
  if (value === 'MAX') return 'MIN';
  return value;
}

function swapConstraints(node) {
  if (!('constraints' in node)) return;

  const constraints = node.constraints;
  const horizontal = constraints.horizontal === 'LEFT'
    ? 'RIGHT'
    : constraints.horizontal === 'RIGHT'
      ? 'LEFT'
      : constraints.horizontal;

  trySet(node, 'constraints', {
    horizontal,
    vertical: constraints.vertical
  });
}

function swapDirectionalRadii(node) {
  if (!('topLeftRadius' in node) || node.topLeftRadius === figma.mixed) return;

  const topLeft = node.topLeftRadius;
  const topRight = node.topRightRadius;
  const bottomLeft = node.bottomLeftRadius;
  const bottomRight = node.bottomRightRadius;

  trySet(node, 'topLeftRadius', topRight);
  trySet(node, 'topRightRadius', topLeft);
  trySet(node, 'bottomLeftRadius', bottomRight);
  trySet(node, 'bottomRightRadius', bottomLeft);
}

function swapDirectionalStrokes(node) {
  if (!('strokeLeftWeight' in node) || !('strokeRightWeight' in node)) return;
  if (!('strokeTopWeight' in node) || !('strokeBottomWeight' in node)) return;

  const top = safeGet(node, 'strokeTopWeight');
  const left = safeGet(node, 'strokeLeftWeight');
  const right = safeGet(node, 'strokeRightWeight');
  const bottom = safeGet(node, 'strokeBottomWeight');
  const weights = [top, right, bottom, left];
  for (const weight of weights) {
    if (weight === undefined || weight === figma.mixed) return;
  }

  trySet(node, 'strokeTopWeight', top);
  trySet(node, 'strokeLeftWeight', right);
  trySet(node, 'strokeRightWeight', left);
  trySet(node, 'strokeBottomWeight', bottom);
}

function trySet(node, key, value) {
  try {
    node[key] = value;
  } catch (error) {
    return false;
  }
  return true;
}
