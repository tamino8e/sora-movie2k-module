var MOFLIX_BASE_URL = "https://moflix-stream.xyz/";

/**
 * Moflix Resolver / Extractor Module
 * Vollständiges Skript mit Unterverarbeitung aller Staffeln über die Moflix API
 */


// ==========================================
// HILFSFUNKTIONEN
// ==========================================

function stripHash(url) {
  if (!url) return "";
  var idx = url.indexOf("#");
  return idx !== -1 ? url.substring(0, idx) : url;
}

function splitHash(url) {
  if (!url) return { base: "", hash: "" };
  var idx = url.indexOf("#");
  if (idx === -1) return { base: url, hash: "" };
  return {
    base: url.substring(0, idx),
    hash: url.substring(idx + 1)
  };
}

function getHashParam(hash, param) {
  if (!hash) return null;
  var params = hash.split("&");
  for (var i = 0; i < params.length; i++) {
    var pair = params[i].split("=");
    if (pair[0] === param) {
      return decodeURIComponent(pair[1] || "");
    }
  }
  return null;
}

function toNumber(val) {
  var num = parseInt(val, 10);
  return isNaN(num) ? 0 : num;
}

function padNumber(num) {
  var n = toNumber(num);
  return n < 10 ? "0" + n : "" + n;
}

function getBaseOrigin(url) {
  if (MOFLIX_BASE_URL) return MOFLIX_BASE_URL;
  try {
    var u = new URL(url);
    return u.origin;
  } catch (e) {
    return "";
  }
}

function absolutizeUrl(path, baseUrl) {
  if (!path) return "";
  if (path.indexOf("http://") === 0 || path.indexOf("https://") === 0) {
    return path;
  }
  var base = baseUrl || MOFLIX_BASE_URL;
  if (base && base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  if (path.indexOf("/") !== 0) {
    path = "/" + path;
  }
  return base + path;
}

async function moflixFetch(url, options) {
  options = options || {};
  if (typeof fetch !== "undefined") {
    return await fetch(url, options);
  }
  throw new Error("fetch is not supported in this environment");
}

async function readResponseText(response) {
  if (response && typeof response.text === "function") {
    return await response.text();
  }
  return response;
}

async function fetchHtml(url) {
  var response = await moflixFetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  return await readResponseText(response);
}

function parseBootstrapData(html) {
  if (!html) return null;
  try {
    var match = html.match(/bootstrapData\s*=\s*({[\s\S]*?});/);
    if (!match) {
      match = html.match(/window\.bootstrapData\s*=\s*({[\s\S]*?});/);
    }
    if (match && match[1]) {
      return JSON.parse(match[1]);
    }
  } catch (e) {
    console.log("parseBootstrapData Error: " + e.message);
  }
  return null;
}

function getTitlePage(bootstrapData) {
  if (!bootstrapData) return {};
  if (bootstrapData.titlePage) return bootstrapData.titlePage;
  if (bootstrapData.routes && bootstrapData.routes.title) return bootstrapData.routes.title;
  return bootstrapData;
}

function getMovieVideoId(titlePage) {
  if (!titlePage) return null;
  var title = titlePage.title || titlePage;
  if (title.primary_video && title.primary_video.id) {
    return title.primary_video.id;
  }
  if (title.videos && Array.isArray(title.videos) && title.videos.length > 0) {
    return title.videos[0].id;
  }
  return null;
}

// ==========================================
// API SEASONS FETCH
// ==========================================

async function fetchSeasonEpisodes(baseUrl, titleId, seasonNumber) {
  try {
    var apiUrl = absolutizeUrl("/api/v1/titles/" + titleId + "/seasons/" + seasonNumber, baseUrl);
    var response = await moflixFetch(apiUrl, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
    var text = await readResponseText(response);
    var data = JSON.parse(text);

    if (data && data.season && Array.isArray(data.season.episodes)) {
      return data.season.episodes;
    }
    if (data && Array.isArray(data.episodes)) {
      return data.episodes;
    }
    if (data && data.episodes && Array.isArray(data.episodes.data)) {
      return data.episodes.data;
    }
  } catch (e) {
    console.log("fetchSeasonEpisodes Error S" + seasonNumber + ": " + e.message);
  }
  return [];
}

// ==========================================
// HAUPTFUNKTIONEN
// ==========================================

/**
 * Extrahiert alle Episoden (inkl. aller Staffeln) einer Serie oder eines Films.
 * @param {string} url - URL der Serie oder des Films
 */
async function extractEpisodes(url) {
  try {
    var cleanUrl = stripHash(url);
    var baseUrl = getBaseOrigin(cleanUrl);

    var html = await fetchHtml(cleanUrl);
    var bootstrapData = parseBootstrapData(html) || {};
    var titlePage = getTitlePage(bootstrapData);
    var title = titlePage.title || {};
    var titleId = title.id;

    var episodes = [];

    // 1. Wenn Staffeln vorhanden sind, jede Staffel einzeln über die API nachladen
    if (titleId && Array.isArray(title.seasons) && title.seasons.length > 0) {
      for (var s = 0; s < title.seasons.length; s += 1) {
        var seasonObj = title.seasons[s];
        var sNum = toNumber(seasonObj.season_number || seasonObj.number);

        if (seasonObj.episodes && Array.isArray(seasonObj.episodes) && seasonObj.episodes.length > 0) {
          episodes = episodes.concat(seasonObj.episodes);
        } else if (sNum > 0) {
          var seasonEps = await fetchSeasonEpisodes(baseUrl, titleId, sNum);
          episodes = episodes.concat(seasonEps);
        }
      }
    }

    // 2. Fallback: Bootstrap-Daten nutzen (oft nur Staffel 1)
    if (!episodes.length) {
      episodes =
        titlePage.episodes && Array.isArray(titlePage.episodes.data)
          ? titlePage.episodes.data.slice()
          : [];
    }

    // 3. Fallback: Spielfilm (Movie)
    if (!episodes.length) {
      var movieVideoId = getMovieVideoId(titlePage);
      if (movieVideoId) {
        return [{
          title: title.name || "Movie",
          season: 0,
          episode: 0,
          url: absolutizeUrl("/watch/" + movieVideoId, baseUrl)
        }];
      }
    }

    // 4. Episoden in einheitliches Format mappen
    return episodes.map(function (item) {
      var sNum = toNumber(item.season_number);
      var eNum = toNumber(item.episode_number);
      var epTitle = item.name || ("Episode " + eNum);
      var videoId = (item.primary_video && item.primary_video.id) || item.video_id;

      var watchUrl = videoId
        ? absolutizeUrl("/watch/" + videoId, baseUrl)
        : cleanUrl + "#season=" + sNum + "&episode=" + eNum;

      return {
        title: "S" + padNumber(sNum) + "E" + padNumber(eNum) + " - " + epTitle,
        season: sNum,
        episode: eNum,
        url: watchUrl
      };
    });
  } catch (e) {
    console.log("extractEpisodes Error: " + e.message);
    return [];
  }
}

/**
 * Ermittelt die Watch-URL für eine bestimmte Staffel/Episode (z. B. aus hash #season=2&episode=1).
 * @param {string} url - URL inkl. Hash-Parametern
 */
async function ensureWatchUrl(url) {
  var parts = splitHash(url);
  var cleanUrl = parts.base;
  var baseUrl = getBaseOrigin(cleanUrl);

  // Falls es schon eine Watch-URL ist
  if (cleanUrl.indexOf("/watch/") !== -1) {
    return cleanUrl;
  }

  var season = toNumber(getHashParam(parts.hash, "season")) || 1;
  var episode = toNumber(getHashParam(parts.hash, "episode")) || 1;

  var html = await fetchHtml(cleanUrl);
  var bootstrapData = parseBootstrapData(html) || {};
  var titlePage = getTitlePage(bootstrapData);
  var title = titlePage.title || {};
  var titleId = title.id;

  var episodes =
    titlePage.episodes && Array.isArray(titlePage.episodes.data)
      ? titlePage.episodes.data
      : [];

  var selectedEpisode = null;

  // Suche in initialen Bootstrap-Daten
  for (var i = 0; i < episodes.length; i += 1) {
    var item = episodes[i];
    if (
      toNumber(item.season_number) === season &&
      toNumber(item.episode_number) === episode
    ) {
      selectedEpisode = item;
      break;
    }
  }

  // Falls nicht in Bootstrap enthalten, direkt per API nachladen
  if (!selectedEpisode && titleId) {
    var fetchedSeason = await fetchSeasonEpisodes(baseUrl, titleId, season);
    for (var j = 0; j < fetchedSeason.length; j += 1) {
      var sItem = fetchedSeason[j];
      if (toNumber(sItem.episode_number) === episode) {
        selectedEpisode = sItem;
        break;
      }
    }
  }

  if (selectedEpisode) {
    if (selectedEpisode.primary_video && selectedEpisode.primary_video.id) {
      return absolutizeUrl("/watch/" + selectedEpisode.primary_video.id, baseUrl);
    }
    if (selectedEpisode.video && selectedEpisode.video.id) {
      return absolutizeUrl("/watch/" + selectedEpisode.video.id, baseUrl);
    }
    if (selectedEpisode.video_id) {
      return absolutizeUrl("/watch/" + selectedEpisode.video_id, baseUrl);
    }
  }

  console.log("Moflix episode not found: S" + padNumber(season) + "E" + padNumber(episode));

  // Movie Fallback
  var movieVideoId = getMovieVideoId(titlePage);
  if (!movieVideoId) {
    return null;
  }

  return absolutizeUrl("/watch/" + movieVideoId, baseUrl);
}

// Falls das Skript in einem Node/CommonJS-Umfeld exportiert werden muss:
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    extractEpisodes: extractEpisodes,
    ensureWatchUrl: ensureWatchUrl
  };
}
