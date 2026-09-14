var MOFLIX_BASE_URL = "https://moflix-stream.xyz/";

async function searchResults(keyword) {
  try {
    var query = cleanupText(keyword);
    if (!query) {
      return JSON.stringify([]);
    }

    var response = await moflixFetch(
      MOFLIX_BASE_URL + "search/" + encodeURIComponent(query)
    );
    var html = await readResponseText(response);
    var bootstrapData = parseBootstrapData(html) || {};
    var searchPage = getSearchPage(bootstrapData);
    var results = [];
    var seen = {};
    var hrefMap = extractSearchHrefMap(html);

    if (Array.isArray(searchPage.results) && searchPage.results.length) {
      for (var i = 0; i < searchPage.results.length; i += 1) {
        var item = searchPage.results[i];

        if (!item || item.model_type !== "title") {
          continue;
        }

        var href = absolutizeUrl(
          hrefMap[String(item.id)] || buildTitleHref(item)
        );

        if (!href || seen[href]) {
          continue;
        }

        seen[href] = true;

        results.push({
          title: cleanupText(item.name),
          image: absolutizeUrl(item.poster),
          href: href
        });
      }
    } else {
      var regex =
        /<a class="contents" href="(\/titles\/[^"]+)"[\s\S]*?<img[^>]+src="([^"]+)"[^>]+alt="Poster for ([^"]+)"/gi;

      var match;

      while ((match = regex.exec(html)) !== null) {
        var fallbackHref = absolutizeUrl(match[1]);

        if (!fallbackHref || seen[fallbackHref]) {
          continue;
        }

        seen[fallbackHref] = true;

        results.push({
          title: cleanupText(decodeHtml(match[3])),
          image: absolutizeUrl(match[2]),
          href: fallbackHref
        });
      }
    }

    return JSON.stringify(results);
  } catch (error) {
    console.log("searchResults error: " + error.message);
    return JSON.stringify([]);
  }
}

async function extractDetails(url) {
  try {
    var html = await fetchHtml(url);
    var bootstrapData = parseBootstrapData(html) || {};
    var titlePage = getTitlePage(bootstrapData);
    var watchPage = getWatchPage(bootstrapData);

    var title =
      titlePage.title ||
      (watchPage.video && watchPage.video.title) ||
      watchPage.title ||
      {};

    var genres = extractNames(title.genres);
    var countries = extractCountryNames(
      title.production_countries || title.countries
    );

    var runtime =
      title.runtime ||
      (watchPage.episode && watchPage.episode.runtime) ||
      "Unknown";

    var year =
      title.year ||
      extractYear(title.release_date) ||
      "Unknown";

    var description =
      cleanupText(title.description) || "No description available";

    return JSON.stringify([
      {
        title: cleanupText(
          title.name ||
            title.title ||
            (watchPage.video && watchPage.video.title) ||
            ""
        ),
        image: absolutizeUrl(title.poster || title.image || title.backdrop),
        description: description,
        aliases: [
          "Genres: " +
            (genres.length ? genres.join(", ") : "Unknown"),
          "Runtime: " + formatRuntime(runtime),
          "Country: " +
            (countries.length ? countries.join(", ") : "Unknown")
        ].join(" | "),
        airdate: String(year)
      }
    ]);
  } catch (error) {
    console.log("extractDetails error: " + error.message);

    return JSON.stringify([
      {
        description: "Error loading description",
        aliases:
          "Genres: Unknown | Runtime: Unknown | Country: Unknown",
        airdate: "Unknown"
      }
    ]);
  }
}

/*
 * Kinoger-style episode output.
 *
 * Series:
 *
 *   href: TITLE_URL#season=1&episode=1
 *   number: 1
 *   title: S01E01
 *
 * Movie:
 *
 *   href: /watch/<videoId>
 *   number: Movie
 */
async function extractEpisodes(url) {
  try {
    var cleanUrl = stripHash(url);
    var html = await fetchHtml(cleanUrl);
    var bootstrapData = parseBootstrapData(html) || {};
    var titlePage = getTitlePage(bootstrapData);
    var title = titlePage.title || {};

    var episodes =
      titlePage.episodes &&
      Array.isArray(titlePage.episodes.data)
        ? titlePage.episodes.data.slice()
        : [];

    /*
     * If Moflix exposes episodes, this is a series.
     */
    if (episodes.length) {
      episodes.sort(function(a, b) {
        var seasonA = toNumber(a && a.season_number);
        var seasonB = toNumber(b && b.season_number);

        if (seasonA !== seasonB) {
          return seasonA - seasonB;
        }

        return (
          toNumber(a && a.episode_number) -
          toNumber(b && b.episode_number)
        );
      });

      var result = [];

      for (var i = 0; i < episodes.length; i += 1) {
        var item = episodes[i];

        if (!item) {
          continue;
        }

        var season = toNumber(item.season_number);
        var episode = toNumber(item.episode_number);

        if (!season) {
          season = 1;
        }

        if (!episode) {
          episode = i + 1;
        }

        /*
         * Important:
         * We deliberately do NOT use the Moflix watch URL here.
         *
         * Instead the title URL is retained and season/episode
         * are encoded in the hash, exactly like Kinoger.js.
         */
        result.push({
          href:
            cleanUrl +
            "#season=" +
            season +
            "&episode=" +
            episode,

          number: episode,

          title:
            "S" +
            padNumber(season) +
            "E" +
            padNumber(episode)
        });
      }

      return JSON.stringify(result);
    }

    /*
     * No episodes -> treat as movie.
     */
    var movieVideoId = getMovieVideoId(titlePage);

    if (!movieVideoId) {
      return JSON.stringify([]);
    }

    return JSON.stringify([
      {
        href: absolutizeUrl("/watch/" + movieVideoId),
        number: "Movie"
      }
    ]);
  } catch (error) {
    console.log("extractEpisodes error: " + error.message);
    return JSON.stringify([]);
  }
}

/*
 * Main stream resolver.
 *
 * Accepts both:
 *
 *   /watch/<id>
 *
 * and Kinoger-style:
 *
 *   /titles/<id>/<slug>#season=1&episode=2
 */
async function extractStreamUrl(url) {
  try {
    var parts = splitHash(url);

    var season =
      toNumber(getHashParam(parts.hash, "season")) || 1;

    var episode =
      toNumber(getHashParam(parts.hash, "episode")) || 1;

    /*
     * ensureWatchUrl() now understands the hash and resolves
     * the correct Moflix episode before continuing.
     */
    var watchUrl = await ensureWatchUrl(url);

    if (!watchUrl) {
      return null;
    }

    var html = await fetchHtml(watchUrl);
    var bootstrapData = parseBootstrapData(html) || {};
    var watchPage = getWatchPage(bootstrapData);

    var videoList = collectWatchVideos(watchPage);

    if (!videoList.length) {
      console.log(
        "No Moflix videos found for S" +
          padNumber(season) +
          "E" +
          padNumber(episode)
      );

      return null;
    }

    var providers = buildGlobalExtractorProviders(videoList);
    var resolved = await moflixMultiExtractor(providers);

    /*
     * Fallback to the original mirror resolver.
     */
    if (!resolved.length) {
      for (var i = 0; i < videoList.length; i += 1) {
        var video = videoList[i];

        var resolvedUrl = await resolveMirror(video.src);

        if (!resolvedUrl) {
          continue;
        }

        if (hasStream(resolved, resolvedUrl)) {
          continue;
        }

        resolved.push({
          provider: detectProvider(video.src),
          quality: video.quality || "Unknown",
          link: resolvedUrl
        });
      }
    }

    if (!resolved.length) {
      return null;
    }

    resolved.sort(function(a, b) {
      return scoreStream(b) - scoreStream(a);
    });

    console.log(
      "Selected Moflix stream for S" +
        padNumber(season) +
        "E" +
        padNumber(episode) +
        ": " +
        resolved[0].link
    );

    /*
     * Same Luna/Sora behaviour as Kinoger.js:
     *
     * Luna -> JSON containing all streams
     * Non-Luna -> best stream URL only
     */
    if (!isLunaRuntime()) {
      return resolved[0].link;
    }

    return JSON.stringify({
      streams: resolved.map(formatStreamSource)
    });
  } catch (error) {
    console.log("extractStreamUrl error: " + error.message);
    return null;
  }
}

function formatStreamSource(stream) {
  var titleParts = [];
  var provider = String(stream.provider || "Moflix");
  var quality = String(stream.quality || "Unknown");

  titleParts.push(provider);

  if (quality && quality !== "Unknown") {
    titleParts.push(quality);
  }

  return {
    provider: provider,
    quality: quality,
    title: titleParts.join(" - "),
    url: stream.link,
    streamUrl: stream.link
  };
}

function buildGlobalExtractorProviders(videoList) {
  var providers = {};

  for (var i = 0; i < videoList.length; i += 1) {
    var src = absolutizeUrl(
      videoList[i] && videoList[i].src
    );

    if (!src) {
      continue;
    }

    var provider = mapMoflixProvider(src);

    providers[src] = provider;
  }

  return providers;
}

function mapMoflixProvider(url) {
  var host = detectProvider(url);

  if (host.indexOf("vidara.") !== -1) {
    return "vidara";
  }

  if (
    host.indexOf("moflix-stream.click") !== -1 ||
    host.indexOf("moflix-stream.link") !== -1
  ) {
    return "packer-Moflix";
  }

  if (host.indexOf("veev.") !== -1) {
    return "veev";
  }

  if (host.indexOf("gupload.") !== -1) {
    return "gupload";
  }

  if (host.indexOf("upns.") !== -1) {
    return "skip";
  }

  if (host.indexOf("rpmplay.") !== -1) {
    return "skip";
  }

  if (isDirectMediaUrl(url)) {
    return "direct";
  }

  return host || "unknown";
}

async function moflixMultiExtractor(providers) {
  var streams = [];

  for (var url in providers) {
    if (
      !Object.prototype.hasOwnProperty.call(
        providers,
        url
      )
    ) {
      continue;
    }

    var providerValue = providers[url];

    /*
     * "packer-Moflix" -> "packer"
     */
    var provider = String(providerValue || "")
      .split("-")[0];

    try {
      var streamUrl = await extractByGlobalProvider(
        url,
        provider
      );

      if (
        !streamUrl ||
        hasStream(streams, streamUrl)
      ) {
        continue;
      }

      streams.push({
        provider: detectProvider(url),
        quality: "Unknown",
        link: streamUrl
      });
    } catch (error) {
      console.log(
        "moflixMultiExtractor " +
          provider +
          " error: " +
          error.message
      );
    }
  }

  return streams;
}

async function extractByGlobalProvider(url, provider) {
  if (provider === "skip") {
    return null;
  }

  if (provider === "direct") {
    return isDirectMediaUrl(url) ? url : null;
  }

  if (provider === "vidara") {
    return await resolveVidaraMirror(url);
  }

  if (provider === "packer") {
    var html = await fetchHtml(url);
    return extractDirectUrlFromHtml(html);
  }

  return null;
}

function hasStream(streams, link) {
  for (var i = 0; i < streams.length; i += 1) {
    if (
      streams[i] &&
      streams[i].link === link
    ) {
      return true;
    }
  }

  return false;
}

/*
 * Converts:
 *
 *   /watch/<id>
 *
 * directly.
 *
 * For:
 *
 *   /titles/...#season=2&episode=5
 *
 * the title page is loaded and the corresponding episode
 * is converted to:
 *
 *   /watch/<primary_video.id>
 */
async function ensureWatchUrl(url) {
  var parts = splitHash(url);
  var cleanUrl = parts.base;

  if (
    cleanUrl.indexOf("/watch/") !== -1
  ) {
    return cleanUrl;
  }

  var season =
    toNumber(getHashParam(parts.hash, "season")) || 1;

  var episode =
    toNumber(getHashParam(parts.hash, "episode")) || 1;

  var html = await fetchHtml(cleanUrl);
  var bootstrapData = parseBootstrapData(html) || {};
  var titlePage = getTitlePage(bootstrapData);

  var title = titlePage.title || {};

  /*
   * If this is a series request, explicitly select
   * the requested season and episode.
   */
  if (
    titlePage.episodes &&
    Array.isArray(titlePage.episodes.data) &&
    titlePage.episodes.data.length
  ) {
    var episodes = titlePage.episodes.data;

    for (var i = 0; i < episodes.length; i += 1) {
      var item = episodes[i];

      if (!item) {
        continue;
      }

      var itemSeason =
        toNumber(item.season_number) || 1;

      var itemEpisode =
        toNumber(item.episode_number) || 1;

      if (
        itemSeason === season &&
        itemEpisode === episode
      ) {
        if (
          item.primary_video &&
          item.primary_video.id
        ) {
          return absolutizeUrl(
            "/watch/" +
              item.primary_video.id
          );
        }

        /*
         * Some Moflix data may expose a video ID
         * differently. Try common alternatives.
         */
        if (item.video && item.video.id) {
          return absolutizeUrl(
            "/watch/" +
              item.video.id
          );
        }

        if (item.video_id) {
          return absolutizeUrl(
            "/watch/" +
              item.video_id
          );
        }

        break;
      }
    }

    console.log(
      "Moflix episode not found: S" +
        padNumber(season) +
        "E" +
        padNumber(episode)
    );

    return null;
  }

  /*
   * Movie fallback.
   */
  var movieVideoId =
    getMovieVideoId(titlePage);

  if (!movieVideoId) {
    return null;
  }

  return absolutizeUrl(
    "/watch/" + movieVideoId
  );
}

async function resolveMirror(url, depth) {
  var currentDepth = depth || 0;
  var normalizedUrl = absolutizeUrl(url);

  if (!normalizedUrl) {
    return null;
  }

  if (isDirectMediaUrl(normalizedUrl)) {
    return normalizedUrl;
  }

  var vidaraResolvedUrl =
    await resolveVidaraMirror(normalizedUrl);

  if (vidaraResolvedUrl) {
    return vidaraResolvedUrl;
  }

  if (currentDepth >= 2) {
    return normalizedUrl;
  }

  try {
    var response =
      await moflixFetch(normalizedUrl);

    var html =
      await readResponseText(response);

    var directUrl =
      extractDirectUrlFromHtml(html);

    if (directUrl) {
      return directUrl;
    }

    var iframeUrl = matchFirst(
      html,
      /<iframe[^>]+src="([^"]+)"/i,
      1
    );

    if (iframeUrl) {
      return await resolveMirror(
        iframeUrl,
        currentDepth + 1
      );
    }
  } catch (error) {
    console.log(
      "resolveMirror fallback for " +
        normalizedUrl +
        ": " +
        error.message
    );
  }

  return normalizedUrl;
}

async function resolveVidaraMirror(url) {
  var match = String(url || "").match(
    /https?:\/\/(?:www\.)?vidara\.(?:to|so)\/e\/([A-Za-z0-9]+)/i
  );

  if (!match || !match[1]) {
    return null;
  }

  try {
    var response = await moflixFetch(
      "https://vidara.to/api/stream",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filecode: match[1],
          device: "ios"
        })
      }
    );

    var text =
      await readResponseText(response);

    var payload = JSON.parse(text);

    if (
      payload &&
      payload.streaming_url
    ) {
      return absolutizeUrl(
        payload.streaming_url
      );
    }
  } catch (error) {
    console.log(
      "resolveVidaraMirror error: " +
        error.message
    );
  }

  return null;
}

function collectWatchVideos(watchPage) {
  var combined = [];
  var seen = {};
  var sources = [];

  if (watchPage.video) {
    sources.push(watchPage.video);
  }

  if (
    Array.isArray(
      watchPage.alternative_videos
    )
  ) {
    for (
      var i = 0;
      i <
      watchPage.alternative_videos.length;
      i += 1
    ) {
      sources.push(
        watchPage.alternative_videos[i]
      );
    }
  }

  for (
    var j = 0;
    j < sources.length;
    j += 1
  ) {
    var item = sources[j];

    var src = absolutizeUrl(
      item && item.src
    );

    if (!src || seen[src]) {
      continue;
    }

    seen[src] = true;

    combined.push({
      src: src,
      quality:
        (item && item.quality) ||
        "Unknown"
    });
  }

  return combined;
}

function getMovieVideoId(titlePage) {
  if (
    titlePage.title &&
    titlePage.title.primary_video &&
    titlePage.title.primary_video.id
  ) {
    return titlePage.title.primary_video.id;
  }

  if (
    Array.isArray(
      titlePage.title &&
        titlePage.title.videos
    ) &&
    titlePage.title.videos.length
  ) {
    return titlePage.title.videos[0].id;
  }

  return null;
}

function getTitlePage(bootstrapData) {
  return (
    (bootstrapData.loaders &&
      bootstrapData.loaders.titlePage) ||
    {}
  );
}

function getWatchPage(bootstrapData) {
  return (
    (bootstrapData.loaders &&
      bootstrapData.loaders.watchPage) ||
    {}
  );
}

function getSearchPage(bootstrapData) {
  return (
    (bootstrapData.loaders &&
      bootstrapData.loaders.searchPage) ||
    {}
  );
}

function parseBootstrapData(html) {
  var marker =
    "window.bootstrapData = ";

  var start =
    String(html || "").indexOf(marker);

  if (start === -1) {
    return null;
  }

  var end =
    String(html || "").indexOf(
      "</script>",
      start
    );

  if (end === -1) {
    return null;
  }

  var raw = String(html || "")
    .slice(
      start + marker.length,
      end
    )
    .trim();

  raw = raw.replace(/;\s*$/, "");

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.log(
      "parseBootstrapData error: " +
        error.message
    );

    return null;
  }
}

function extractSearchHrefMap(html) {
  var hrefMap = {};

  var regex =
    /href="(\/titles\/(\d+)\/[^"]+)"/gi;

  var match;

  while (
    (match = regex.exec(
      String(html || "")
    )) !== null
  ) {
    var href = match[1];
    var id = match[2];

    if (!id || hrefMap[id]) {
      continue;
    }

    hrefMap[id] = href;
  }

  return hrefMap;
}

function buildTitleHref(item) {
  if (!item || !item.id) {
    return null;
  }

  var slugSource =
    item.name ||
    item.original_title ||
    "";

  var slug =
    slugifyTitle(slugSource);

  return (
    "/titles/" +
    item.id +
    (slug ? "/" + slug : "")
  );
}

function slugifyTitle(value) {
  return cleanupText(value)
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      "");
}

async function fetchHtml(url) {
  var response =
    await moflixFetch(
      stripHash(url)
    );

  return await readResponseText(
    response
  );
}

function xhrFetch(url, options) {
  return new Promise(
    function(resolve, reject) {
      if (
        typeof XMLHttpRequest !==
        "function"
      ) {
        reject(
          new Error(
            "XMLHttpRequest is not available"
          )
        );

        return;
      }

      var xhr =
        new XMLHttpRequest();

      xhr.open(
        options.method || "GET",
        url,
        true
      );

      var headers =
        options.headers || {};

      var headerKeys =
        Object.keys(headers);

      for (
        var i = 0;
        i < headerKeys.length;
        i += 1
      ) {
        xhr.setRequestHeader(
          headerKeys[i],
          headers[headerKeys[i]]
        );
      }

      xhr.onload =
        function() {
          resolve({
            status: xhr.status,
            responseText:
              xhr.responseText,

            text: function() {
              return Promise.resolve(
                xhr.responseText
              );
            }
          });
        };

      xhr.onerror =
        function() {
          reject(
            new Error(
              "XHR request failed"
            )
          );
        };

      xhr.send(
        options.body || null
      );
    }
  );
}

async function moflixFetch(
  url,
  options
) {
  options =
    options || {
      headers: {},
      method: "GET",
      body: null
    };

  var requestOptions = {
    headers:
      options.headers || {},
    method:
      options.method || "GET",
    body:
      options.body || null
  };

  try {
    return await xhrFetch(
      url,
      requestOptions
    );
  } catch (error) {}

  try {
    if (
      typeof fetchv2 ===
        "function" &&
      isLunaRuntime()
    ) {
      var response =
        await fetchv2(
          url,
          requestOptions.headers,
          requestOptions.method,
          requestOptions.body,
          true,
          "utf-8"
        );

      if (response) {
        return response;
      }
    }
  } catch (error) {
    console.log(
      "moflixFetch fetchv2 luna-style error: " +
        error.message
    );
  }

  try {
    if (
      typeof fetchv2 ===
      "function"
    ) {
      return await fetchv2(
        url,
        requestOptions
      );
    }
  } catch (error) {
    console.log(
      "moflixFetch fetchv2 options-style error: " +
        error.message
    );
  }

  try {
    if (
      typeof fetch ===
      "function"
    ) {
      if (
        requestOptions.method !==
          "GET" ||
        requestOptions.body
      ) {
        return await fetch(
          url,
          requestOptions
        );
      }

      return await fetch(
        url,
        requestOptions.headers
      );
    }
  } catch (error) {
    console.log(
      "moflixFetch fetch error: " +
        error.message
    );
  }

  return null;
}

function isLunaRuntime() {
  return (
    typeof fetchV2Native ===
      "function" ||
    typeof fetchNative ===
      "function"
  );
}

async function readResponseText(
  response
) {
  if (!response) {
    return "";
  }

  if (
    typeof response.text ===
    "function"
  ) {
    return await response.text();
  }

  if (
    typeof response.responseText ===
    "string"
  ) {
    return response.responseText;
  }

  return String(response);
}

function extractDirectUrlFromHtml(
  html
) {
  var normalizedHtml =
    String(html || "");

  var patterns = [
    /https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/i,

    /https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/i,

    /["'](?:file|src|stream|hls|manifest)["']\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,

    /sources?\s*:\s*\[\s*\{\s*(?:file|src)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i
  ];

  for (
    var i = 0;
    i < patterns.length;
    i += 1
  ) {
    var match =
      normalizedHtml.match(
        patterns[i]
      );

    if (!match) {
      continue;
    }

    var candidate =
      absolutizeUrl(
        decodeJsString(
          match[1] ||
            match[0]
        )
      );

    if (
      candidate &&
      isDirectMediaUrl(
        candidate
      )
    ) {
      return candidate;
    }
  }

  var scriptRegex =
    /<script[^>]*>([\s\S]*?)<\/script>/gi;

  var scriptMatch;

  while (
    (scriptMatch =
      scriptRegex.exec(
        normalizedHtml
      )) !== null
  ) {
    var scriptContent =
      String(
        scriptMatch[1] || ""
      ).trim();

    if (
      scriptContent.indexOf(
        "eval(function(p,a,c,k,e,d"
      ) === -1
    ) {
      continue;
    }

    try {
      var unpackedScript =
        unpack(scriptContent);

      for (
        var j = 0;
        j < patterns.length;
        j += 1
      ) {
        var unpackedMatch =
          unpackedScript.match(
            patterns[j]
          );

        if (!unpackedMatch) {
          continue;
        }

        var unpackedCandidate =
          absolutizeUrl(
            decodeJsString(
              unpackedMatch[1] ||
                unpackedMatch[0]
            )
          );

        if (
          unpackedCandidate &&
          isDirectMediaUrl(
            unpackedCandidate
          )
        ) {
          return unpackedCandidate;
        }
      }
    } catch (error) {
      console.log(
        "extractDirectUrlFromHtml unpack error: " +
          error.message
      );
    }
  }

  return null;
}

function scoreStream(stream) {
  var score = 0;

  var link =
    String(
      stream.link || ""
    ).toLowerCase();

  var provider =
    String(
      stream.provider || ""
    ).toLowerCase();

  if (
    link.indexOf(".m3u8") !== -1
  ) {
    score += 120;
  }

  if (
    link.indexOf(".mp4") !== -1
  ) {
    score += 110;
  }

  if (
    !isDirectMediaUrl(link)
  ) {
    score -= 100;
  }

  if (
    provider.indexOf(
      "vidara"
    ) !== -1
  ) {
    score += 90;
  } else if (
    provider.indexOf(
      "veev"
    ) !== -1
  ) {
    score += 20;
  } else if (
    provider.indexOf(
      "moflix-stream.click"
    ) !== -1
  ) {
    score += 40;
  } else if (
    provider.indexOf(
      "moflix-stream.link"
    ) !== -1
  ) {
    score += 75;
  } else if (
    provider.indexOf(
      "gupload"
    ) !== -1
  ) {
    score += 70;
  } else if (
    provider.indexOf(
      "upns"
    ) !== -1
  ) {
    score += 60;
  } else if (
    provider.indexOf(
      "rpmplay"
    ) !== -1
  ) {
    score += 55;
  }

  if (
    link.indexOf("/watch/") ===
      -1 &&
    link.indexOf("/embed/") ===
      -1 &&
    link.indexOf("/e/") === -1
  ) {
    score += 20;
  }

  return score;
}

function detectProvider(url) {
  var normalizedUrl =
    String(url || "");

  var match =
    normalizedUrl.match(
      /^https?:\/\/([^/]+)/i
    );

  return match
    ? match[1].toLowerCase()
    : "unknown";
}

function isDirectMediaUrl(url) {
  var normalizedUrl =
    String(url || "")
      .toLowerCase();

  return (
    normalizedUrl.indexOf(
      ".m3u8"
    ) !== -1 ||
    normalizedUrl.indexOf(
      ".mp4"
    ) !== -1
  );
}

function extractNames(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map(function(item) {
      return cleanupText(
        item &&
          (item.display_name ||
            item.name)
      );
    })
    .filter(Boolean);
}

function extractCountryNames(
  items
) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map(function(item) {
      return cleanupText(
        item &&
          (item.display_name ||
            item.name ||
            item.country ||
            item.native_name ||
            item.iso)
      );
    })
    .filter(Boolean);
}

function formatRuntime(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === "Unknown"
  ) {
    return "Unknown";
  }

  return String(value) + " min";
}

function extractYear(value) {
  var match =
    String(value || "").match(
      /\b(?:19|20)\d{2}\b/
    );

  return match
    ? match[0]
    : null;
}

function cleanupText(value) {
  return decodeHtml(
    String(value || "")
  )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&apos;/g,
      "'"
    )
    .replace(
      /&lt;/g,
      "<"
    )
    .replace(
      /&gt;/g,
      ">"
    )
    .replace(
      /&nbsp;/g,
      " "
    )
    .replace(
      /&#(\d+);/g,
      function(_, code) {
        return String.fromCharCode(
          parseInt(
            code,
            10
          )
        );
      }
    );
}

function decodeJsString(value) {
  return String(value || "")
    .replace(
      /\\u0026/g,
      "&"
    )
    .replace(
      /\\\//g,
      "/"
    )
    .replace(
      /\\\\/g,
      "\\"
    );
}

function stripHash(url) {
  return String(url || "")
    .split("#")[0];
}

/*
 * Same hash handling as Kinoger.js.
 */
function splitHash(url) {
  var parts =
    String(url || "").split("#");

  return {
    base: parts[0],
    hash: parts
      .slice(1)
      .join("#")
  };
}

function getHashParam(hash, key) {
  var pairs =
    String(hash || "").split("&");

  for (
    var i = 0;
    i < pairs.length;
    i += 1
  ) {
    var pair =
      pairs[i].split("=");

    if (
      decodeURIComponent(
        pair[0] || ""
      ) === key
    ) {
      return decodeURIComponent(
        pair
          .slice(1)
          .join("=")
      );
    }
  }

  return "";
}

function absolutizeUrl(url) {
  var value =
    String(url || "").trim();

  if (!value) {
    return "";
  }

  if (
    value.indexOf(
      "http://"
    ) === 0 ||
    value.indexOf(
      "https://"
    ) === 0
  ) {
    return value;
  }

  if (
    value.indexOf("//") === 0
  ) {
    return "https:" + value;
  }

  if (
    value.charAt(0) === "/"
  ) {
    return (
      MOFLIX_BASE_URL.replace(
        /\/+$/,
        ""
      ) + value
    );
  }

  return (
    MOFLIX_BASE_URL +
    value.replace(
      /^\/+/,
      ""
    )
  );
}

function padNumber(value) {
  var number =
    toNumber(value);

  return number < 10
    ? "0" + number
    : String(number);
}

function toNumber(value) {
  var parsed =
    parseInt(
      value,
      10
    );

  return isNaN(parsed)
    ? 0
    : parsed;
}

function matchFirst(
  value,
  regex,
  groupIndex
) {
  var match =
    String(value || "").match(
      regex
    );

  return match
    ? match[groupIndex || 0]
    : "";
}

class Unbaser {
  constructor(base) {
    this.ALPHABET = {
      62:
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",

      95:
        "' !\"#$%&\\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'"
    };

    this.dictionary = {};
    this.base = base;

    if (
      36 < base &&
      base < 62
    ) {
      this.ALPHABET[base] =
        this.ALPHABET[base] ||
        this.ALPHABET[62].substr(
          0,
          base
        );
    }

    if (
      2 <= base &&
      base <= 36
    ) {
      this.unbase =
        function(value) {
          return parseInt(
            value,
            base
          );
        };
    } else {
      if (
        !this.ALPHABET[base]
      ) {
        throw new Error(
          "Unsupported base encoding."
        );
      }

      for (
        var i = 0;
        i <
        this.ALPHABET[base]
          .length;
        i += 1
      ) {
        this.dictionary[
          this.ALPHABET[base][i]
        ] = i;
      }

      this.unbase =
        this._dictunbaser.bind(
          this
        );
    }
  }

  _dictunbaser(value) {
    var result = 0;

    var chars =
      String(value || "")
        .split("")
        .reverse();

    for (
      var i = 0;
      i < chars.length;
      i += 1
    ) {
      result +=
        Math.pow(
          this.base,
          i
        ) *
        this.dictionary[
          chars[i]
        ];
    }

    return result;
  }
}

function unpack(source) {
  var args =
    /}\('([\s\S]*?)', *(\d+|\[\]), *(\d+), *'([\s\S]*?)'\.split\('\|'\), *(\d+), *([\s\S]*?)\)\);?/.exec(
      source
    ) ||
    /}\('([\s\S]*?)', *(\d+|\[\]), *(\d+), *'([\s\S]*?)'\.split\('\|'\)\);?/.exec(
      source
    );

  if (!args) {
    throw new Error(
      "Could not unpack packed script."
    );
  }

  var payload = args[1];
  var radix = parseInt(
    args[2],
    10
  );

  var count = parseInt(
    args[3],
    10
  );

  var symtab =
    args[4].split("|");

  if (
    count !==
    symtab.length
  ) {
    throw new Error(
      "Malformed p.a.c.k.e.r. symtab."
    );
  }

  var unbaser =
    new Unbaser(radix);

  return payload.replace(
    /\b\w+\b/g,
    function(word) {
      var index =
        radix === 1
          ? parseInt(
              word,
              10
            )
          : unbaser.unbase(
              word
            );

      return (
        symtab[index] ||
        word
      );
    }
  );
}
