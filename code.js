figma.showUI(__html__, { width: 380, height: 640, themeColors: true });

const DEFAULT_GAP = 96;

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
        email: await readSetting('email')
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
    figma.ui.postMessage({ type: 'settings-saved', ok: true });
    return;
  }

  if (message.type === 'reset-translation-settings') {
    await writeSetting('provider', 'mymemory');
    await writeSetting('endpoint', '');
    await writeSetting('apiKey', '');
    await writeSetting('region', '');
    await writeSetting('email', '');
    figma.ui.postMessage({ type: 'settings-reset', ok: true });
    return;
  }

  if (message.type !== 'convert') return;

  const settings = message.settings || {};

  const selection = figma.currentPage.selection;
  if (!selection.length) {
    figma.notify('请先选中一个或多个画板 / Frame');
    figma.ui.postMessage({ type: 'done', ok: false });
    return;
  }

  try {
    const converted = [];
    for (const node of selection) {
      const source = getEditableSource(node);
      let target = settings.createCopy ? cloneBeside(source) : source;
      target = detachInstances(target);
      if (settings.createCopy) target.name = source.name + ' - AR RTL';

      await convertNode(target, settings);
      converted.push(target);
    }

    figma.currentPage.selection = converted;
    figma.viewport.scrollAndZoomIntoView(converted);
    figma.notify('已处理 ' + converted.length + ' 个对象');
    figma.ui.postMessage({ type: 'done', ok: true });
  } catch (error) {
    figma.notify('转换失败：' + error.message);
    figma.ui.postMessage({ type: 'done', ok: false, error: error.message });
  }
};

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

function cloneBeside(node) {
  const clone = node.clone();

  const parent = canAppendTo(node.parent) ? node.parent : figma.currentPage;
  if (clone.parent !== parent) {
    parent.appendChild(clone);
  }

  if ('x' in clone && 'width' in node) {
    trySet(clone, 'x', node.x + node.width + DEFAULT_GAP);
  }
  if ('y' in clone) trySet(clone, 'y', node.y);
  return clone;
}

function canAppendTo(parent) {
  return parent && parent.type !== 'INSTANCE' && !isInsideInstance(parent);
}

function getEditableSource(node) {
  const instance = findContainingInstance(node);
  return instance || node;
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
  await translateTexts(root, settings);
  mirrorContainer(root, true);
}

async function translateTexts(node, settings) {
  const textNodes = [];
  collectTextNodes(node, textNodes);

  for (const textNode of textNodes) {
    await loadTextFonts(textNode);
  }

  let translations = {};
  if (settings.translate) {
    translations = await buildTranslationMap(textNodes, settings);
  }

  for (const textNode of textNodes) {
    applyTextUpdate(textNode, translations);
  }
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
  for (const node of textNodes) {
    const text = String(node.characters || '');
    if (!normalizeTextForTranslation(text) || seen[text]) continue;
    seen[text] = true;

    const localText = transformLocalText(text);
    if (localText !== text) {
      translations[text] = localText;
      continue;
    }

    if (!containsChinese(text)) continue;
    uniqueTexts.push(text);
  }

  if (!uniqueTexts.length) return translations;

  if (normalizeProvider(settings.provider) === 'custom') {
    const remoteTranslations = await translateTextBatch(uniqueTexts, settings);
    return mergeTranslations(translations, remoteTranslations);
  }

  for (const text of uniqueTexts) {
    translations[text] = await translateText(text, settings);
  }
  return translations;
}

function mergeTranslations(base, extra) {
  for (const key in extra) {
    base[key] = extra[key];
  }
  return base;
}

function normalizeTextForTranslation(value) {
  return String(value || '').trim();
}

function transformLocalText(value) {
  return transformChineseDateTime(value);
}

function transformChineseDateTime(value) {
  return String(value || '').replace(
    /(\d{4})[年\/.-](\d{1,2})[月\/.-](\d{1,2})日?\s+(\d{1,2})[:：\/](\d{1,2})(?:[:：\/](\d{1,2}))?/g,
    function (_match, year, month, day, hour, minute, second) {
      const date = pad2(day) + '/' + pad2(month) + '/' + year;
      const time = pad2(hour) + '/' + pad2(minute) + '/' + pad2(second || '00');
      return time + ' ' + date;
    }
  );
}

function pad2(value) {
  const text = String(value);
  return text.length === 1 ? '0' + text : text;
}

function applyTextUpdate(node, translations) {
  const text = String(node.characters || '');
  if (text && translations[text]) {
    node.characters = translations[text];
  }

  if (node.textAlignHorizontal === 'LEFT') {
    trySet(node, 'textAlignHorizontal', 'RIGHT');
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
      target: 'ar',
      target_lang: 'AR',
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

async function translateWithMyMemory(text, settings) {
  const email = (settings.email || '').trim();
  let url = 'https://api.mymemory.translated.net/get?q='
    + encodeURIComponent(text)
    + '&langpair='
    + encodeURIComponent('zh-CN|ar');
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
      target: 'ar',
      target_lang: 'AR',
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
  if (isVectorArtworkContainer(node)) return;

  const children = node.children.slice();
  for (const child of children) {
    mirrorContainer(child, false);
  }

  if (node.type === 'GROUP') return;

  mirrorAutoLayout(node);
  if ('width' in node) {
    mirrorChildrenPositions(node, children);
  }

  if (!isRoot) {
    swapConstraints(node);
  }
  swapDirectionalRadii(node);
}

function isVectorArtworkContainer(node) {
  if (!('children' in node) || !node.children.length) return false;
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

function mirrorAutoLayout(node) {
  if (!('layoutMode' in node)) return;
  if (node.layoutMode === 'NONE') return;

  mirrorAutoLayoutHorizontalPadding(node);
  if (node.layoutMode === 'HORIZONTAL' && 'children' in node) {
    reverseChildOrder(node);
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

  for (const child of children) {
    if (!('x' in child) || !('width' in child)) continue;
    if (isAutoLayout && child.layoutPositioning !== 'ABSOLUTE') continue;
    if (isRotatedImageFillNode(child)) continue;
    trySet(child, 'x', parent.width - child.x - child.width);
    swapConstraints(child);
  }
}

function isRotatedImageFillNode(node) {
  if (!('fills' in node) || !('rotation' in node)) return false;
  if (Math.abs(node.rotation) < 0.01) return false;
  if (node.fills === figma.mixed) return false;

  for (const paint of node.fills) {
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

function trySet(node, key, value) {
  try {
    node[key] = value;
  } catch (error) {
    return false;
  }
  return true;
}
