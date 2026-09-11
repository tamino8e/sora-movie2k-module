var MOFLIX_BASE_URL = "https://moflix-stream.xyz/";


// ==========================================
// HELPER FUNCTIONS
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

function absolutizeUrl(path) {
  if (!path) return "";
  if (path.indexOf("http://") === 0 || path.indexOf("https://") === 0) {
    return path;
  }
  var base = MOFLIX_BASE_URL || "";
  if (base.length > 0 && base.charAt(base.length - 1) === "/") {
    base = base.substring(0, base.length - 1);
  }
  if (path.indexOf("/") !== 0) {
    path = "/" + path;
  }
  return base + path;
}

async function fetchHtml(url) {
  var response = await moflixFetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
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
// MOFLIX API FETCH FOR EXTRA SEASONS
// ==========================================

async function fetchSeasonEpisodes(titleId, seasonNumber) {
  try {
    var apiUrl = absolutizeUrl("/api/v1/titles/" + titleId + "/seasons/" + seasonNumber);
    var response = await moflixFetch(apiUrl, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
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
// SORA / LUNA MODULE EXPORTS
// ==========================================

async function extractEpisodes(url) {
  try {
    var cleanUrl = stripHash(url);
    var html = await fetchHtml(cleanUrl);
    var bootstrapData = parseBootstrapData(html) || {};
    var titlePage = getTitlePage(bootstrapData);
    var title = titlePage.title || {};
    var titleId = title.id;

    var episodes = [];

    // 1. Alle Staffeln über Moflix API nachladen
    if (titleId && Array.isArray(title.seasons) && title.seasons.length > 0) {
      for (var s = 0; s < title.seasons.length; s += 1) {
        var seasonObj = title.seasons[s];
        var sNum = toNumber(seasonObj.season_number || seasonObj.number);

        if (seasonObj.episodes && Array.isArray(seasonObj.episodes) && seasonObj.episodes.length > 0) {
          episodes = episodes.concat(seasonObj.episodes);
        } else if (sNum > 0) {
          var seasonEps = await fetchSeasonEpisodes(titleId, sNum);
          episodes = episodes.concat(seasonEps);
        }
      }
    }

    // 2. Fallback für initiale Bootstrap-Daten
    if (!episodes.length) {
      episodes =
        titlePage.episodes && Array.isArray(titlePage.episodes.data)
          ? titlePage.episodes.data.slice()
          : [];
    }

    // 3. Fallback für Spielfilme
    if (!episodes.length) {
      var movieVideoId = getMovieVideoId(titlePage);
      if (movieVideoId) {
        return [{
          title: title.name || "Movie",
          season: 0,
          episode: 0,
          url: absolutizeUrl("/watch/" + movieVideoId)
        }];
      }
    }

    // 4. Mappen auf das Standardformat des Moduls
    return episodes.map(function (item) {
      var sNum = toNumber(item.season_number);
      var eNum = toNumber(item.episode_number);
      var epTitle = item.name || ("Episode " + eNum);
      var videoId = (item.primary_video && item.primary_video.id) || item.video_id;

      var watchUrl = videoId
        ? absolutizeUrl("/watch/" + videoId)
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

async function ensureWatchUrl(url) {
  var parts = splitHash(url);
  var cleanUrl = parts.base;

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

  if (!selectedEpisode && titleId) {
    var fetchedSeason = await fetchSeasonEpisodes(titleId, season);
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
      return absolutizeUrl("/watch/" + selectedEpisode.primary_video.id);
    }
    if (selectedEpisode.video && selectedEpisode.video.id) {
      return absolutizeUrl("/watch/" + selectedEpisode.video.id);
    }
    if (selectedEpisode.video_id) {
      return absolutizeUrl("/watch/" + selectedEpisode.video_id);
    }
  }

  console.log("Moflix episode not found: S" + padNumber(season) + "E" + padNumber(episode));

  var movieVideoId = getMovieVideoId(titlePage);
  if (!movieVideoId) {
    return null;
  }

  return absolutizeUrl("/watch/" + movieVideoId);
}
