var KINOGER_BASE_URL = "https://kinoger.ch/";
var KINOGER_SEARCH_URL =
  "https://kinoger.ch/index.php?do=search&subaction=search&titleonly=3&story=";
var KINOGER_PLAYER_PROVIDERS = ["pw", "fsst", "go", "ollhd"];
var KINOGER_DEFAULT_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Referer": KINOGER_BASE_URL,
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.2; rv:147.0) Gecko/20100101 Firefox/147.0"
};

async function searchResults(keyword) {
  try {
    var query = cleanupText(keyword);
    if (!query) {
      return JSON.stringify([]);
    }

    var results = await searchKinogerQuery(query);
    var fallbacks = buildSearchFallbacks(query);

    for (var i = 0; i < fallbacks.length && !results.length; i += 1) {
      results = await searchKinogerQuery(fallbacks[i]);
    }

    console.log("Kinoger search '" + query + "' returned " + results.length + " result(s)");

    return JSON.stringify(results);
  } catch (error) {
    console.log("searchResults error: " + error.message);
    return JSON.stringify([]);
  }
}

async function searchKinogerQuery(query) {
  var response = await kinogerFetch(KINOGER_SEARCH_URL + encodeURIComponent(query));
  var html = await readResponseText(response);
  var results = parseSearchResults(html);

  console.log(
    "Kinoger query '" +
      query +
      "' status=" +
      (response && response.status ? response.status : "unknown") +
      " html=" +
      String(html || "").length +
      " titlecontrol=" +
      countMatches(html, /<div\s+class=["']titlecontrol["'][^>]*>/gi) +
      " results=" +
      results.length
  );

  return results;
}

function buildSearchFallbacks(query) {
  var cleaned = cleanupText(query)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/[–—:|]+/g, " - ");
  var candidates = [];
  var parts = cleaned.split(/\s+-\s+/);

  addSearchFallback(candidates, cleaned);

  for (var i = 0; i < parts.length; i += 1) {
    addSearchFallback(candidates, parts[i]);
  }

  if (parts.length > 1) {
    addSearchFallback(candidates, parts[parts.length - 1]);
  }

  return candidates.filter(function(item) {
    return item && item !== query;
  });
}

function addSearchFallback(candidates, value) {
  var normalized = cleanupText(value);
  if (normalized.length < 3 || candidates.indexOf(normalized) !== -1) {
    return;
  }

  candidates.push(normalized);
}

function countMatches(value, regex) {
  var source = String(value || "");
  var count = 0;

  while (regex.exec(source) !== null) {
    count += 1;
  }

  return count;
}

async function extractDetails(url) {
  try {
    var html = await fetchHtml(url);
    var title =
      cleanupTitle(matchFirst(html, /<h1[^>]+id=["']news-title["'][^>]*>([\s\S]*?)<\/h1>/i, 1)) ||
      cleanupTitle(getMetaContent(html, "og:title")) ||
      "Unknown";
    var detailBlock = extractImagesBorderHtml(html);
    var image =
      absolutizeUrl(getMetaContent(html, "og:image")) ||
      absolutizeUrl(matchFirst(detailBlock, /<img[^>]+src=["']([^"']+)["']/i, 1));
    var detailText = htmlToTextWithBreaks(detailBlock);
    var description =
      cleanupText(getMetaContent(html, "og:description")) ||
      cleanupDescription(detailText) ||
      "No description available";
    var metadata = extractMetadata(detailText, html);
    var aliases = buildAliases(metadata);
    var airdate = extractYear(title) || extractYear(metadata.released) || "Unknown";

    return JSON.stringify([
      {
        title: title,
        image: image,
        description: description,
        aliases: aliases,
        airdate: airdate
      }
    ]);
  } catch (error) {
    console.log("extractDetails error: " + error.message);
    return JSON.stringify([
      {
        description: "Error loading description",
        aliases: "IMDb: Unknown | Genre: Unknown | Runtime: Unknown",
        airdate: "Unknown"
      }
    ]);
  }
}

async function extractEpisodes(url) {
  try {
    var cleanUrl = stripHash(url);
    var html = await fetchHtml(cleanUrl);
    var playerCalls = parsePlayerCalls(html);

    if (!isSeriesPage(html, playerCalls)) {
      return JSON.stringify([
        {
          href: cleanUrl,
          number: "Movie"
        }
      ]);
    }

    var episodeMap = buildEpisodeMap(playerCalls);
    var episodes = [];

    for (var season = 1; season <= episodeMap.length; season += 1) {
      var episodeCount = episodeMap[season - 1] || 0;
      for (var episode = 1; episode <= episodeCount; episode += 1) {
        episodes.push({
          href: cleanUrl + "#season=" + season + "&episode=" + episode,
          number: episode,
          title: "S" + padNumber(season) + "E" + padNumber(episode)
        });
      }
    }

    return JSON.stringify(episodes);
  } catch (error) {
    console.log("extractEpisodes error: " + error.message);
    return JSON.stringify([]);
  }
}

async function extractStreamUrl(url) {
  try {
    var parts = splitHash(url);
    var season = toNumber(getHashParam(parts.hash, "season")) || 1;
    var episode = toNumber(getHashParam(parts.hash, "episode")) || 1;
    var html = await fetchHtml(parts.base);
    var playerCalls = parsePlayerCalls(html);
    var embedStreams = selectStreams(playerCalls, season, episode, isSeriesPage(html, playerCalls));
    var streams = [];
    var seen = {};

    for (var i = 0; i < embedStreams.length; i += 1) {
      var embedStream = embedStreams[i];
      var resolved = await resolveEmbedStreams(embedStream.link, embedStream.provider);

      for (var j = 0; j < resolved.length; j += 1) {
        var media = resolved[j];
        if (!media || !media.url || seen[media.url]) {
          continue;
        }

        seen[media.url] = true;
        streams.push(
          formatResolvedStream(
            embedStream.provider,
            media.url,
            media.quality || embedStream.quality,
            embedStream.link
          )
        );
      }
    }

    if (!streams.length) {
      return null;
    }

    streams.sort(function(a, b) {
      return scoreStream(b) - scoreStream(a);
    });

    if (!isLunaRuntime()) {
      return streams[0].streamUrl || streams[0].url || streams[0].link;
    }

    return JSON.stringify({
      streams: streams
    });
  } catch (error) {
    console.log("extractStreamUrl error: " + error.message);
    return null;
  }
}

function parseSearchResults(html) {
  var results = [];
  var seen = {};
  var parts = String(html || "").split(/<div\s+class=["']titlecontrol["'][^>]*>/i);

  for (var i = 1; i < parts.length; i += 1) {
    var itemHtml = parts[i];
    var endIndex = itemHtml.indexOf('<div class="separator2"');
    if (endIndex !== -1) {
      itemHtml = itemHtml.slice(0, endIndex);
    }

    var linkMatch = itemHtml.match(/<a[^>]+href=["']((?:https?:\/\/(?:www\.)?kinoger\.[a-z]+)?\/stream\/[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) {
      continue;
    }

    var href = absolutizeUrl(linkMatch[1]);
    if (!href || seen[href]) {
      continue;
    }

    var image =
      absolutizeUrl(
        matchFirst(
          itemHtml,
          /<div[^>]+class=["'][^"']*content_text[^"']*searchresult_img[^"']*["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/i,
          1
        )
      ) ||
      absolutizeUrl(matchFirst(itemHtml, /<!--dle_image_begin:([^|]+)\|/i, 1));
    var title = cleanupTitle(linkMatch[2]).replace(/\s+Film$/i, "");

    if (!title) {
      continue;
    }

    seen[href] = true;
    results.push({
      title: title,
      image: image,
      href: href
    });
  }

  return results;
}

function extractImagesBorderHtml(html) {
  var source = String(html || "");
  var startMatch = /<div[^>]+class=["'][^"']*images-border[^"']*["'][^>]*>/i.exec(source);
  if (!startMatch) {
    return "";
  }

  var start = startMatch.index;
  var afterStart = start + startMatch[0].length;
  var endMarkers = ["<hr>", "<center>", "<span class=\"klicken", "<div id=\"style\""];
  var end = source.length;

  for (var i = 0; i < endMarkers.length; i += 1) {
    var markerIndex = source.indexOf(endMarkers[i], afterStart);
    if (markerIndex !== -1 && markerIndex < end) {
      end = markerIndex;
    }
  }

  return source.slice(start, end);
}

function parsePlayerCalls(html) {
  var calls = [];
  var normalizedHtml = String(html || "");

  for (var i = 0; i < KINOGER_PLAYER_PROVIDERS.length; i += 1) {
    var provider = KINOGER_PLAYER_PROVIDERS[i];
    var regex = new RegExp("\\b" + provider + "\\.show\\s*\\(", "g");
    var match;

    while ((match = regex.exec(normalizedHtml)) !== null) {
      var args = readBalanced(normalizedHtml, regex.lastIndex - 1, "(", ")");
      if (!args) {
        continue;
      }

      var arrayStart = args.value.indexOf("[");
      if (arrayStart === -1) {
        continue;
      }

      var arrayLiteral = readBalanced(args.value, arrayStart, "[", "]");
      if (!arrayLiteral) {
        continue;
      }

      var parsed = parseJsArray("[" + arrayLiteral.value + "]");
      var matrix = normalizeSeasonMatrix(parsed);
      if (!matrix.length) {
        continue;
      }

      calls.push({
        provider: provider,
        seasons: toNumber(args.value.slice(0, arrayStart).replace(/,/g, "")) || matrix.length,
        urls: matrix
      });
    }
  }

  return calls;
}

function selectStreams(playerCalls, season, episode, isSeries) {
  var streams = [];
  var seen = {};

  for (var i = 0; i < playerCalls.length; i += 1) {
    var call = playerCalls[i];
    var link = "";

    if (isSeries) {
      link = call.urls[season - 1] && call.urls[season - 1][episode - 1];
    } else {
      link = call.urls[0] && call.urls[0][0];
    }

    link = normalizeEmbedUrl(link);
    if (!link || seen[link]) {
      continue;
    }

    seen[link] = true;
    streams.push(formatStream(call.provider, link));
  }

  return streams;
}

function formatStream(providerKey, link) {
  var provider = mapProviderName(providerKey, link);
  var quality = mapProviderQuality(providerKey);

  return {
    provider: provider,
    quality: quality,
    link: link,
    title: provider + " - " + quality,
    url: link,
    streamUrl: link
  };
}

function formatResolvedStream(provider, link, quality, referer) {
  var cleanProvider = provider || detectProvider(link) || "Kinoger";
  var cleanQuality = quality || detectQuality(link) || "Unknown";
  var titleParts = [cleanProvider];
  var headers = buildPlaybackHeaders(link, referer);

  if (cleanQuality && cleanQuality !== "Unknown") {
    titleParts.push(cleanQuality);
  }

  return {
    provider: cleanProvider,
    quality: cleanQuality,
    link: link,
    title: titleParts.join(" - "),
    url: link,
    streamUrl: link,
    headers: headers
  };
}

function buildPlaybackHeaders(link, referer) {
  var host = detectProvider(link);

  if (host.indexOf("incvideo") !== -1 || host.indexOf("filevideo") !== -1) {
    return {
      "Referer": "",
      "Origin": ""
    };
  }

  var headers = {};
  var origin = getOrigin(referer);

  if (referer) {
    headers.Referer = referer;
  }

  if (origin) {
    headers.Origin = origin;
  }

  return headers;
}

async function resolveEmbedStreams(url, provider) {
  var normalizedUrl = normalizeEmbedUrl(url);
  var directMedia = [];

  if (!normalizedUrl) {
    return directMedia;
  }

  if (isDirectMediaUrl(normalizedUrl)) {
    directMedia.push({
      url: normalizedUrl,
      quality: detectQuality(normalizedUrl)
    });
    return directMedia;
  }

  try {
    var response = await kinogerFetch(normalizedUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        "Referer": KINOGER_BASE_URL
      }
    });
    var html = await readResponseText(response);
    var mediaSources = extractMediaSources(html, normalizedUrl);

    if (mediaSources.length) {
      return mediaSources;
    }

    var iframeUrl = absolutizeAgainst(
      matchFirst(html, /<iframe[^>]+src=["']([^"']+)["']/i, 1),
      normalizedUrl
    );
    if (iframeUrl && iframeUrl !== normalizedUrl) {
      var iframeResponse = await kinogerFetch(iframeUrl, {
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
          "Referer": normalizedUrl
        }
      });
      return extractMediaSources(await readResponseText(iframeResponse), iframeUrl);
    }
  } catch (error) {
    console.log("resolveEmbedStreams " + provider + " error: " + error.message);
  }

  return directMedia;
}

function extractMediaSources(html, baseUrl) {
  var source = String(html || "");
  var results = [];
  var seen = {};
  var fileRegex = /\b(?:file|src|source)\s*:\s*(["'])([\s\S]*?)\1/gi;
  var match;

  while ((match = fileRegex.exec(source)) !== null) {
    addMediaSources(results, seen, parseMediaList(match[2], baseUrl));
  }

  var sourceRegex = /<source[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((match = sourceRegex.exec(source)) !== null) {
    addMediaSources(results, seen, parseMediaList(match[1], baseUrl));
  }

  var directRegex = /(https?:\/\/[^"'\s\\,]+?\.(?:m3u8|mp4)(?:\/|\?[^"'\s\\,]*)?)/gi;
  while ((match = directRegex.exec(source)) !== null) {
    addMediaSources(results, seen, [
      {
        url: cleanMediaUrl(match[1], baseUrl),
        quality: detectQuality(match[1])
      }
    ]);
  }

  results.sort(function(a, b) {
    return scoreQuality(b.quality, b.url) - scoreQuality(a.quality, a.url);
  });

  return results;
}

function parseMediaList(value, baseUrl) {
  var raw = decodeJsString(decodeHtml(value || ""));
  var parts = raw.split(",");
  var results = [];

  for (var i = 0; i < parts.length; i += 1) {
    var part = cleanupText(parts[i]);
    var quality = "";
    var labeledMatch = part.match(/^\[([^\]]+)\]\s*(.+)$/);

    if (labeledMatch) {
      quality = cleanupText(labeledMatch[1]);
      part = labeledMatch[2];
    }

    var directMatch = part.match(/(https?:\/\/\S+?\.(?:m3u8|mp4)(?:\/|\?\S*)?)/i);
    var directUrl = cleanMediaUrl(directMatch ? directMatch[1] : part, baseUrl);

    if (!directUrl || !isDirectMediaUrl(directUrl)) {
      continue;
    }

    results.push({
      url: directUrl,
      quality: quality || detectQuality(directUrl)
    });
  }

  return results;
}

function addMediaSources(results, seen, sources) {
  for (var i = 0; i < sources.length; i += 1) {
    var source = sources[i];
    if (!source || !source.url || seen[source.url] || !isDirectMediaUrl(source.url)) {
      continue;
    }

    seen[source.url] = true;
    results.push(source);
  }
}

function buildEpisodeMap(playerCalls) {
  var episodeMap = [];

  for (var i = 0; i < playerCalls.length; i += 1) {
    var matrix = playerCalls[i].urls || [];
    for (var season = 0; season < matrix.length; season += 1) {
      var count = matrix[season] ? matrix[season].length : 0;
      episodeMap[season] = Math.max(episodeMap[season] || 0, count);
    }
  }

  return episodeMap;
}

function isSeriesPage(html, playerCalls) {
  if (String(html || "").indexOf("/stream/serie/") !== -1) {
    return true;
  }

  for (var i = 0; i < playerCalls.length; i += 1) {
    if ((playerCalls[i].urls || []).length > 1 || playerCalls[i].seasons > 1) {
      return true;
    }
  }

  return false;
}

function normalizeSeasonMatrix(value) {
  var matrix = [];
  if (!Array.isArray(value)) {
    return matrix;
  }

  if (value.length && typeof value[0] === "string") {
    matrix.push(cleanUrlList(value));
    return matrix;
  }

  for (var i = 0; i < value.length; i += 1) {
    if (Array.isArray(value[i])) {
      matrix.push(cleanUrlList(flattenStrings(value[i])));
    }
  }

  return matrix.filter(function(items) {
    return items.length > 0;
  });
}

function flattenStrings(value) {
  var result = [];
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i += 1) {
      var nested = flattenStrings(value[i]);
      for (var j = 0; j < nested.length; j += 1) {
        result.push(nested[j]);
      }
    }
  } else if (typeof value === "string") {
    result.push(value);
  }

  return result;
}

function cleanUrlList(items) {
  var result = [];
  for (var i = 0; i < items.length; i += 1) {
    var url = normalizeEmbedUrl(items[i]);
    if (url) {
      result.push(url);
    }
  }

  return result;
}

function parseJsArray(source) {
  var text = String(source || "");
  var index = 0;

  function skipWhitespace() {
    while (index < text.length && /\s/.test(text.charAt(index))) {
      index += 1;
    }
  }

  function parseString() {
    var quote = text.charAt(index);
    var output = "";
    index += 1;

    while (index < text.length) {
      var char = text.charAt(index);
      if (char === "\\") {
        output += char;
        index += 1;
        if (index < text.length) {
          output += text.charAt(index);
          index += 1;
        }
        continue;
      }

      if (char === quote) {
        index += 1;
        return decodeJsString(output);
      }

      output += char;
      index += 1;
    }

    return decodeJsString(output);
  }

  function parseArray() {
    var array = [];
    index += 1;
    skipWhitespace();

    while (index < text.length && text.charAt(index) !== "]") {
      var char = text.charAt(index);
      if (char === "[" ) {
        array.push(parseArray());
      } else if (char === "'" || char === '"') {
        array.push(parseString());
      } else {
        while (index < text.length && text.charAt(index) !== "," && text.charAt(index) !== "]") {
          index += 1;
        }
      }

      skipWhitespace();
      if (text.charAt(index) === ",") {
        index += 1;
        skipWhitespace();
      }
    }

    if (text.charAt(index) === "]") {
      index += 1;
    }

    return array;
  }

  skipWhitespace();
  if (text.charAt(index) !== "[") {
    return [];
  }

  return parseArray();
}

function readBalanced(source, startIndex, openChar, closeChar) {
  var text = String(source || "");
  var depth = 0;
  var quote = "";
  var escaped = false;

  for (var i = startIndex; i < text.length; i += 1) {
    var char = text.charAt(i);

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          value: text.slice(startIndex + 1, i),
          end: i + 1
        };
      }
    }
  }

  return null;
}

function extractMetadata(detailText, html) {
  var text = cleanupText(detailText);
  var categoryHtml = matchFirst(html, /<li\s+class=["']category["'][^>]*>([\s\S]*?)<\/li>/i, 1);
  var categoryText = cleanupText(categoryHtml).replace(/^Stream\s*\/?\s*/i, "");
  var metadata = {
    imdb: findLabeledValue(text, "IMDb"),
    runtime: findLabeledValue(text, "Laufzeit"),
    genre: findLabeledValue(text, "Genre") || categoryText,
    originalTitle: findLabeledValue(text, "Orginal Titel") || findLabeledValue(text, "Original Titel"),
    released: findLabeledValue(text, "Released"),
    cast: findLabeledValue(text, "Schauspieler"),
    director: findLabeledValue(text, "Regie & Drehbuch")
  };

  return metadata;
}

function findLabeledValue(text, label) {
  var labels =
    "IMDb|Laufzeit|Genre|Schauspieler|Regie\\s*&\\s*Drehbuch|Released|Orginal Titel|Original Titel|Casts";
  var escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+");
  var regex = new RegExp(
    "(?:^|\\s)" + escapedLabel + "\\s*:?\\s*([\\s\\S]*?)(?=\\s+(?:" + labels + ")\\s*:?\\s|$)",
    "i"
  );
  var match = String(text || "").match(regex);
  return match ? cleanupText(match[1]) : "";
}

function buildAliases(metadata) {
  var aliases = [];
  aliases.push("IMDb: " + (metadata.imdb || "Unknown"));
  aliases.push("Genre: " + (metadata.genre || "Unknown"));
  aliases.push("Runtime: " + (metadata.runtime || "Unknown"));

  if (metadata.originalTitle) {
    aliases.push("Original Title: " + metadata.originalTitle);
  }

  if (metadata.released) {
    aliases.push("Released: " + metadata.released);
  }

  if (metadata.cast) {
    aliases.push("Cast: " + metadata.cast);
  }

  if (metadata.director) {
    aliases.push("Director: " + metadata.director);
  }

  return aliases.join(" | ");
}

function cleanupDescription(value) {
  return cleanupText(String(value || "").replace(/\bIMDb\s*:[\s\S]*$/i, ""));
}

function mapProviderName(providerKey, link) {
  if (providerKey === "pw") {
    return "FSST";
  }

  if (providerKey === "fsst") {
    return "P2PPlay";
  }

  if (providerKey === "go") {
    return "Kinoger";
  }

  if (providerKey === "ollhd") {
    return "Seekplays";
  }

  return detectProvider(link) || providerKey || "Unknown";
}

function mapProviderQuality(providerKey) {
  if (providerKey === "pw" || providerKey === "fsst") {
    return "Stream HD+";
  }

  if (providerKey === "go" || providerKey === "ollhd") {
    return "Stream HD";
  }

  return "Embed";
}

async function fetchHtml(url) {
  var response = await kinogerFetch(stripHash(url));
  return await readResponseText(response);
}

function xhrFetch(url, options) {
  return new Promise(function(resolve, reject) {
    if (typeof XMLHttpRequest !== "function") {
      reject(new Error("XMLHttpRequest is not available"));
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open(options.method || "GET", url, true);

    var headers = options.headers || {};
    var headerKeys = Object.keys(headers);
    for (var i = 0; i < headerKeys.length; i += 1) {
      xhr.setRequestHeader(headerKeys[i], headers[headerKeys[i]]);
    }

    xhr.onload = function() {
      resolve({
        status: xhr.status,
        responseText: xhr.responseText,
        text: function() {
          return Promise.resolve(xhr.responseText);
        }
      });
    };

    xhr.onerror = function() {
      reject(new Error("XHR request failed"));
    };

    xhr.send(options.body || null);
  });
}

async function kinogerFetch(url, options) {
  var headers = mergeHeaders(KINOGER_DEFAULT_HEADERS, (options && options.headers) || {});
  var requestOptions = {
    headers: headers,
    method: (options && options.method) || "GET",
    body: (options && options.body) || null
  };

  try {
    return await xhrFetch(url, requestOptions);
  } catch (error) {}

  try {
    if (typeof fetchv2 === "function") {
      var lunaResponse = await fetchv2(
        url,
        requestOptions.headers,
        requestOptions.method,
        requestOptions.body,
        true,
        "utf-8"
      );
      if (lunaResponse) {
        return lunaResponse;
      }
    }
  } catch (error) {
    console.log("kinogerFetch fetchv2 luna-style error: " + error.message);
  }

  try {
    if (typeof fetchv2 === "function") {
      return await fetchv2(url, requestOptions);
    }
  } catch (error) {
    console.log("kinogerFetch fetchv2 options-style error: " + error.message);
  }

  try {
    if (typeof fetch === "function") {
      if (requestOptions.method !== "GET" || requestOptions.body) {
        return await fetch(url, requestOptions);
      }

      return await fetch(url, requestOptions.headers);
    }
  } catch (error) {
    console.log("kinogerFetch fetch error: " + error.message);
  }

  return null;
}

function mergeHeaders(defaults, overrides) {
  var merged = {};
  var defaultKeys = Object.keys(defaults || {});
  var overrideKeys = Object.keys(overrides || {});
  var i;

  for (i = 0; i < defaultKeys.length; i += 1) {
    merged[defaultKeys[i]] = defaults[defaultKeys[i]];
  }

  for (i = 0; i < overrideKeys.length; i += 1) {
    merged[overrideKeys[i]] = overrides[overrideKeys[i]];
  }

  return merged;
}

function isLunaRuntime() {
  return typeof fetchNative === "function" || typeof fetchV2Native === "function";
}

async function readResponseText(response) {
  if (!response) {
    return "";
  }

  if (typeof response.text === "function") {
    return await response.text();
  }

  if (typeof response.responseText === "string") {
    return response.responseText;
  }

  if (typeof response.body === "string") {
    return response.body;
  }

  if (typeof response._data === "string") {
    return response._data;
  }

  return String(response);
}

function getMetaContent(html, property) {
  var metaRegex = /<meta\b[^>]*>/gi;
  var match;

  while ((match = metaRegex.exec(String(html || ""))) !== null) {
    var tag = match[0];
    var name = getAttributeValue(tag, "property") || getAttributeValue(tag, "name");
    if (name !== property) {
      continue;
    }

    return decodeHtml(getAttributeValue(tag, "content"));
  }

  return "";
}

function getAttributeValue(tag, name) {
  var regex = new RegExp("\\b" + escapeRegex(name) + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1", "i");
  var match = String(tag || "").match(regex);
  return match ? match[2] : "";
}

function htmlToTextWithBreaks(value) {
  return decodeHtml(String(value || ""))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function cleanupTitle(value) {
  return cleanupText(value)
    .replace(/^StartSeite\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupText(value) {
  return decodeHtml(String(value || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, function(_, code) {
      return String.fromCharCode(parseInt(code, 10));
    });
}

function decodeJsString(value) {
  return String(value || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, function(_, code) {
      return String.fromCharCode(parseInt(code, 16));
    })
    .replace(/\\\//g, "/")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function normalizeEmbedUrl(url) {
  return absolutizeUrl(cleanupText(url));
}

function isDirectMediaUrl(url) {
  var value = String(url || "").toLowerCase();
  return value.indexOf(".m3u8") !== -1 || value.indexOf(".mp4") !== -1;
}

function cleanMediaUrl(url, baseUrl) {
  var value = decodeHtml(decodeJsString(String(url || "")))
    .replace(/\\\//g, "/")
    .replace(/^[\s"']+|[\s"']+$/g, "")
    .replace(/[)\]}]+$/g, "")
    .trim();

  return absolutizeAgainst(value, baseUrl);
}

function absolutizeUrl(url) {
  var value = String(url || "").trim();
  if (!value) {
    return "";
  }

  if (value.indexOf("http://") === 0 || value.indexOf("https://") === 0) {
    return value;
  }

  if (value.indexOf("//") === 0) {
    return "https:" + value;
  }

  if (value.charAt(0) === "/") {
    return KINOGER_BASE_URL.replace(/\/+$/, "") + value;
  }

  return KINOGER_BASE_URL + value.replace(/^\/+/, "");
}

function absolutizeAgainst(url, baseUrl) {
  var value = String(url || "").trim();
  var base = String(baseUrl || KINOGER_BASE_URL);
  var origin = getOrigin(base) || KINOGER_BASE_URL.replace(/\/+$/, "");
  var pathBase = base.split("#")[0].split("?")[0];

  if (!value) {
    return "";
  }

  if (value.indexOf("http://") === 0 || value.indexOf("https://") === 0) {
    return value;
  }

  if (value.indexOf("//") === 0) {
    return "https:" + value;
  }

  if (value.charAt(0) === "/") {
    return origin + value;
  }

  return pathBase.replace(/\/[^\/]*$/, "/") + value;
}

function getOrigin(url) {
  var match = String(url || "").match(/^(https?:\/\/[^\/]+)/i);
  return match ? match[1] : "";
}

function detectQuality(value) {
  var match = String(value || "").match(/(?:^|[_\-\[\s\/])(\d{3,4})p(?:\]|[_\-\s\/.]|$)/i);
  return match ? match[1] + "p" : "Unknown";
}

function scoreStream(stream) {
  return scoreQuality(stream && stream.quality, stream && (stream.link || stream.url || stream.streamUrl));
}

function scoreQuality(quality, url) {
  var score = 0;
  var qualityText = String(quality || "");
  var qualityMatch = qualityText.match(/(\d{3,4})p/i);
  var link = String(url || "").toLowerCase();

  if (qualityMatch) {
    score += parseInt(qualityMatch[1], 10);
  }

  if (link.indexOf(".m3u8") !== -1) {
    score += 20;
  }

  if (link.indexOf(".mp4") !== -1) {
    score += 10;
  }

  return score;
}

function splitHash(url) {
  var parts = String(url || "").split("#");
  return {
    base: parts[0],
    hash: parts.slice(1).join("#")
  };
}

function stripHash(url) {
  return splitHash(url).base;
}

function getHashParam(hash, key) {
  var pairs = String(hash || "").split("&");
  for (var i = 0; i < pairs.length; i += 1) {
    var pair = pairs[i].split("=");
    if (decodeURIComponent(pair[0] || "") === key) {
      return decodeURIComponent(pair.slice(1).join("="));
    }
  }

  return "";
}

function detectProvider(url) {
  var match = String(url || "").match(/^https?:\/\/([^/]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function padNumber(value) {
  var number = toNumber(value);
  return number < 10 ? "0" + number : String(number);
}

function toNumber(value) {
  var parsed = parseInt(value, 10);
  return isNaN(parsed) ? 0 : parsed;
}

function extractYear(value) {
  var match = String(value || "").match(/\b(?:19|20)\d{2}\b/);
  return match ? match[0] : "";
}

function matchFirst(value, regex, groupIndex) {
  var match = String(value || "").match(regex);
  return match ? match[groupIndex || 0] : "";
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
