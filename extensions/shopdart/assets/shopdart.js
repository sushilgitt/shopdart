/**
 * Shopdart storefront player.
 *
 * No framework, no dependencies, no build step. This file runs on every page
 * of a merchant's storefront, so weight is a feature: the whole thing is
 * smaller than the hls.js payload alone, which is why short clips play from a
 * progressive MP4 and HLS is never loaded at all.
 *
 * Rules this file lives by:
 *  - Never block render. Deferred script, data fetched after paint.
 *  - Never download video the shopper hasn't looked at. Posters are lazy, the
 *    video element only gets a src when its tile is near the viewport.
 *  - Never shift the page. Every container reserves space before it fills.
 */
(function () {
  "use strict";

  // Set to the deployed app origin. One line to change if the domain moves.
  var ORIGIN = "https://shopdart.91.239.208.85.sslip.io";

  var PAGE_TO_TARGET = {
    index: "HOME",
    product: "PRODUCT",
    collection: "COLLECTION",
    list_collections: "COLLECTION",
    cart: "CART",
  };

  if (!("IntersectionObserver" in window)) return;

  // ---------------------------------------------------------------- data ---

  var payloadPromise = null;

  function loadPayload(shop) {
    if (payloadPromise) return payloadPromise;
    payloadPromise = fetch(ORIGIN + "/w/" + shop + "/widgets.json", {
      credentials: "omit",
      mode: "cors",
    })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .catch(function () {
        // A storefront must not break because our origin is unreachable.
        return null;
      });
    return payloadPromise;
  }

  // -------------------------------------------------------------- events ---

  var queue = [];
  var sessionKey = null;
  var flushTimer = null;

  /**
   * How long a queued event may wait before it is sent.
   *
   * Batching exists to avoid a request per interaction, but a batch that only
   * leaves on `pagehide` is indistinguishable from broken: a merchant — or an
   * app reviewer — who plays a video and switches to the admin sees nothing,
   * because the storefront tab is still open and the queue is still sitting in
   * it. Two seconds keeps the batching and makes the data show up while the
   * person who caused it is still looking.
   */
  var FLUSH_DELAY_MS = 2000;

  function session() {
    if (sessionKey) return sessionKey;
    try {
      sessionKey = sessionStorage.getItem("shopdart_s");
      if (!sessionKey) {
        sessionKey = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem("shopdart_s", sessionKey);
      }
    } catch (error) {
      sessionKey = Math.random().toString(36).slice(2);
    }
    return sessionKey;
  }

  function track(shop, type, widgetId, videoId, productId) {
    queue.push({
      type: type,
      widgetId: widgetId,
      videoId: videoId,
      productId: productId,
      session: session(),
    });
    if (queue.length >= 10) flush(shop);
    else scheduleFlush(shop);
  }

  function scheduleFlush(shop) {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush(shop);
    }, FLUSH_DELAY_MS);
  }

  /**
   * Body type is load-bearing, not incidental.
   *
   * `text/plain` is one of the three CORS-safelisted content types, so this
   * stays a "simple" cross-origin request and the browser sends it straight
   * through. `application/json` is not safelisted: it forces a preflight, and a
   * preflight cannot be answered here — React Router routes only GET and the
   * mutation methods, so an OPTIONS request never reaches the route and is
   * rejected with a bare 405. Every beacon that needed a preflight was
   * therefore dropped by the browser before it ever left.
   *
   * The server reads the body as text and parses it, so the payload is
   * unchanged.
   */
  function flush(shop) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queue.length) return;
    var body = JSON.stringify({ shop: shop, events: queue.splice(0, 50) });
    // sendBeacon survives the page unloading; fetch does not.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        ORIGIN + "/api/events",
        new Blob([body], { type: "text/plain;charset=UTF-8" })
      );
    } else {
      fetch(ORIGIN + "/api/events", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: body,
        keepalive: true,
        mode: "cors",
      }).catch(function () {});
    }
  }

  // ---------------------------------------------------------------- cart ---

  /**
   * Stamps the cart so the order can be credited back to this video.
   *
   * Must be /cart/update.js, not /cart/add.js: only cart-level attributes
   * survive into the order as note_attributes, which is what the orders/create
   * webhook reads. Line item properties would be visible to the shopper and
   * would not travel.
   */
  function stampCart(videoId, widgetId) {
    var attributes = {};
    attributes["_shopdart_video"] = videoId;
    attributes["_shopdart_widget"] = widgetId;
    attributes["_shopdart_session"] = session();

    return fetch("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: attributes }),
      // The shopper may be navigating to the product page as this fires.
      // Without keepalive the request is cancelled and the sale that follows
      // is credited to nobody.
      keepalive: true,
    }).catch(function () {
      // Attribution is a nice-to-have; never let it break the purchase.
    });
  }

  function addToCart(variantId, button, onDone) {
    var original = button.textContent;
    button.disabled = true;
    button.textContent = "Adding…";

    fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ id: Number(variantId), quantity: 1 }] }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("cart");
        button.textContent = "Added";
        // Themes differ in how they refresh the cart. Fire the common signals
        // and let whichever the theme listens for pick it up.
        ["cart:refresh", "cart:build", "shopify:cart:update"].forEach(function (name) {
          document.dispatchEvent(new CustomEvent(name, { bubbles: true }));
        });
        if (onDone) onDone();
        setTimeout(function () {
          button.textContent = original;
          button.disabled = false;
        }, 1800);
      })
      .catch(function () {
        button.textContent = "Unavailable";
        setTimeout(function () {
          button.textContent = original;
          button.disabled = false;
        }, 1800);
      });
  }

  // -------------------------------------------------------------- render ---

  function el(tag, className, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (attrs[key] !== null && attrs[key] !== undefined) {
          node.setAttribute(key, attrs[key]);
        }
      });
    }
    return node;
  }

  function ratioValue(ratio) {
    var parts = String(ratio || "9:16").split(":");
    return parts[0] + " / " + parts[1];
  }

  // Store currency, taken from the payload. Without it prices render as bare
  // numbers, which reads as a bug to shoppers outside the merchant's country.
  var CURRENCY = null;

  function money(amount) {
    if (amount === null || amount === undefined) return "";
    try {
      if (CURRENCY) {
        return amount.toLocaleString(undefined, {
          style: "currency",
          currency: CURRENCY,
        });
      }
      return amount.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch (error) {
      return String(amount);
    }
  }

  /** "Powered by Shopdart" badge — free plan only. */
  function buildWatermark() {
    var link = el("a", "shopdart__badge", {
      href: "https://shopdart.io",
      target: "_blank",
      rel: "noopener nofollow",
    });
    link.textContent = "Powered by Shopdart";
    return link;
  }

  /** Products visible over the video at any one moment. More is a wall. */
  var MAX_VISIBLE_PRODUCTS = 2;
  /** Cards built per video. Beyond this the payload stops earning its bytes. */
  var MAX_BUILT_PRODUCTS = 6;

  function buildProducts(video, config, shop, widget) {
    if (!config.showProductCard || !video.products.length) return null;
    var wrap = el("div", "shopdart__products");
    var entries = [];

    video.products.slice(0, MAX_BUILT_PRODUCTS).forEach(function (product) {
      var card = el("div", "shopdart__product");

      if (product.image) {
        card.appendChild(
          el("img", null, { src: product.image, alt: "", loading: "lazy" })
        );
      }

      var text = el("div", "shopdart__product-text");
      var title = el("span", "shopdart__product-title");
      title.textContent = product.title;
      text.appendChild(title);

      var priceEl = el("span", "shopdart__product-price");
      text.appendChild(priceEl);
      card.appendChild(text);

      /**
       * Shows the price of what the shopper would actually buy.
       *
       * `product.price` is the cheapest variant — a "from" figure cached at tag
       * time. Rendering it bare next to a picker defaulting to a different
       * variant meant the card said one price and the cart charged another. So
       * once a variant is known, its own price is shown; the cached minimum is
       * only used when no variant list exists, and then it says so.
       */
      function showPrice(amount, isFrom) {
        if (amount === null || amount === undefined) {
          priceEl.textContent = "";
          return;
        }
        priceEl.textContent = (isFrom ? "From " : "") + money(amount);
      }

      // Variants a shopper can actually buy. Sold-out ones are dropped rather
      // than shown disabled: a picker of unbuyable options reads as broken.
      var buyable = (product.variants || []).filter(function (variant) {
        return variant && variant.id && variant.available !== false;
      });

      function trackTap() {
        track(shop, "PRODUCT_CLICK", widget.id, video.id, product.id);
        flush(shop);
      }

      /**
       * Claims the cart for this video, so the eventual order can be credited.
       *
       * Timing matters. The Ajax cart serialises writes per cart token, so
       * firing /cart/update.js alongside /cart/add.js risks losing the
       * attributes to a 422 — and those attributes are the entire attribution
       * mechanism. On the buy path this therefore runs only once the add has
       * come back; on the link path there is no competing write, so it goes
       * immediately, before the shopper navigates away.
       */
      function stamp() {
        stampCart(video.id, widget.id);
      }

      function buy(variantId, button) {
        trackTap();
        addToCart(variantId, button, function () {
          stamp();
          track(shop, "ADD_TO_CART", widget.id, video.id, product.id);
          flush(shop);
        });
      }

      // A pinned variant means the product had exactly one, so the cached list
      // holds the price the shopper will actually pay.
      if (product.variantId) {
        showPrice(buyable.length ? buyable[0].price : product.price, false);
      } else if (buyable.length >= 1) {
        showPrice(buyable[0].price, false);
      } else {
        // No variant list — older tags cached before variants were read. The
        // minimum is all we have, so label it rather than imply it is the price.
        showPrice(product.price, true);
      }

      if (product.variantId) {
        var button = el("button", "shopdart__cta", { type: "button" });
        button.textContent = config.ctaLabel || "Shop now";
        button.addEventListener("click", function (event) {
          event.stopPropagation();
          event.preventDefault();
          buy(product.variantId, button);
        });
        card.appendChild(button);
      } else if (buyable.length > 1) {
        // The common case for real catalogues. Sending these shoppers to the
        // product page is what stops a "shoppable" video being shoppable, so
        // the choice happens here instead.
        var select = el("select", "shopdart__variants", {
          "aria-label": "Choose an option",
        });
        buyable.forEach(function (variant) {
          var option = el("option", null, { value: variant.id });
          option.textContent =
            variant.price !== null && variant.price !== undefined
              ? variant.title + " — " + money(variant.price)
              : variant.title;
          select.appendChild(option);
        });
        // The select and its button sit inside a tile that toggles playback on
        // click; without this, choosing a size pauses the video.
        select.addEventListener("click", function (event) {
          event.stopPropagation();
        });
        // Keep the headline price honest as the shopper changes their mind.
        select.addEventListener("change", function () {
          for (var i = 0; i < buyable.length; i += 1) {
            if (buyable[i].id === select.value) {
              showPrice(buyable[i].price, false);
              return;
            }
          }
        });
        card.appendChild(select);

        var pickerButton = el("button", "shopdart__cta", { type: "button" });
        pickerButton.textContent = config.ctaLabel || "Shop now";
        pickerButton.addEventListener("click", function (event) {
          event.stopPropagation();
          event.preventDefault();
          buy(select.value, pickerButton);
        });
        card.appendChild(pickerButton);
      } else if (buyable.length === 1) {
        var soleButton = el("button", "shopdart__cta", { type: "button" });
        soleButton.textContent = config.ctaLabel || "Shop now";
        soleButton.addEventListener("click", function (event) {
          event.stopPropagation();
          event.preventDefault();
          buy(buyable[0].id, soleButton);
        });
        card.appendChild(soleButton);
      } else if (product.handle) {
        // Last resort: nothing buyable is known for this product, so send the
        // shopper to the product page. The cart is still claimed on the way
        // out so a purchase there is attributed back to this video.
        var link = el("a", "shopdart__cta", { href: "/products/" + product.handle });
        link.textContent = "View";
        link.addEventListener("click", function (event) {
          event.stopPropagation();
          trackTap();
          stamp();
        });
        card.appendChild(link);
      }

      wrap.appendChild(card);
      entries.push({ product: product, card: card });
    });

    /**
     * Shows the products due at `seconds` of playback.
     *
     * Tags carry a start/end window that the admin already reports back to the
     * merchant ("shown 1s to 9s"), but the player used to ignore it and pin the
     * first two products for the whole clip. Same data, two different answers
     * depending on where you looked.
     */
    wrap._sync = function (seconds) {
      var shown = 0;
      entries.forEach(function (entry) {
        var from = entry.product.from;
        var to = entry.product.to;
        var started = from === null || from === undefined || seconds >= from;
        var ended = to !== null && to !== undefined && seconds > to;
        var due = started && !ended && shown < MAX_VISIBLE_PRODUCTS;
        entry.card.hidden = !due;
        if (due) shown += 1;
      });
    };
    wrap._sync(0);

    return wrap;
  }

  // ------------------------------------------------------------- youtube ---

  /**
   * Loads YouTube's IFrame API once, and only when a YouTube tile actually
   * exists on the page.
   *
   * This script is deliberately small; their API is not. Stores with no
   * YouTube videos must pay nothing for the capability, which is why this is
   * demand-loaded rather than a tag in the theme.
   */
  var ytApiPromise = null;

  function loadYouTubeApi() {
    if (ytApiPromise) return ytApiPromise;

    ytApiPromise = new Promise(function (resolve) {
      if (window.YT && window.YT.Player) return resolve(window.YT);

      // The theme, or another app, may already be loading it. Chain onto the
      // existing callback rather than clobbering it.
      var previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof previous === "function") previous();
        resolve(window.YT);
      };

      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        var script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;
        document.head.appendChild(script);
      }
    });

    return ytApiPromise;
  }

  /**
   * A tile backed by YouTube's embedded player.
   *
   * Shares the tile contract with the hosted path — _load, _play, _pause,
   * _impression — so observe(), the layouts and the product card need no
   * knowledge of which provider they are dealing with.
   */
  function buildYouTubeTile(video, config, shop, widget) {
    var tile = el("div", "shopdart__tile shopdart__tile--embed", {
      "aria-label": video.title || "Shoppable video",
    });

    if (video.poster) {
      tile.appendChild(
        el("img", "shopdart__media shopdart__poster", {
          src: video.poster,
          alt: "",
          loading: "lazy",
          decoding: "async",
        })
      );
    }

    var host = el("div", "shopdart__media shopdart__embed");
    tile.appendChild(host);

    var products = buildProducts(video, config, shop, widget);
    if (products) tile.appendChild(products);

    var player = null;
    var wantsPlay = false;
    // YouTube's player emits no timeupdate, so the product window is polled
    // while the clip is actually playing and stopped as soon as it is not.
    var syncTimer = null;

    function startSync() {
      if (syncTimer || !products || !products._sync) return;
      syncTimer = setInterval(function () {
        if (player && player.getCurrentTime) {
          products._sync(player.getCurrentTime() || 0);
        }
      }, 500);
    }

    function stopSync() {
      if (!syncTimer) return;
      clearInterval(syncTimer);
      syncTimer = null;
    }

    tile._load = function () {
      if (host.dataset.loaded) return;
      host.dataset.loaded = "1";

      loadYouTubeApi().then(function (YT) {
        player = new YT.Player(host, {
          videoId: video.embedId,
          playerVars: {
            // Autoplay only survives browser policy while muted, exactly as
            // with the hosted path.
            autoplay: wantsPlay ? 1 : 0,
            mute: 1,
            controls: 1,
            playsinline: 1,
            rel: 0,
            loop: config.loop !== false ? 1 : 0,
            // loop is ignored unless a playlist is named; a single-video
            // playlist of itself is the documented workaround.
            playlist: config.loop !== false ? video.embedId : undefined,
          },
          events: {
            onReady: function (event) {
              event.target.mute();
              if (wantsPlay) event.target.playVideo();
            },
            onStateChange: function (event) {
              if (event.data === YT.PlayerState.PLAYING) {
                tile.dataset.playing = "true";
                markViewed();
              }
              if (event.data === YT.PlayerState.PAUSED) {
                tile.dataset.playing = "false";
              }
              if (event.data === YT.PlayerState.ENDED) {
                track(shop, "VIEW_COMPLETE", widget.id, video.id);
              }
            },
          },
        });
      });
    };

    function markViewed() {
      if (tile.dataset.viewed) return;
      tile.dataset.viewed = "1";
      track(shop, "VIEW_START", widget.id, video.id);
    }

    tile._play = function () {
      wantsPlay = true;
      tile._load();
      if (player && player.playVideo) player.playVideo();
      // data-playing is set from onStateChange, once YouTube confirms it.
      startSync();
    };

    tile._pause = function () {
      wantsPlay = false;
      if (player && player.pauseVideo) player.pauseVideo();
      tile.dataset.playing = "false";
      stopSync();
    };

    return tile;
  }

  // -------------------------------------------------------------- tiktok ---

  /**
   * A tile backed by TikTok's embedded player.
   *
   * Shares the tile contract with the hosted path — _load, _play, _pause,
   * _impression — so observe(), the layouts and the product card need no
   * knowledge of which provider they are dealing with.
   *
   * Two differences from the YouTube tile are worth knowing:
   *
   *  - No API script is loaded. TikTok's player is driven entirely by
   *    postMessage, so the cost of supporting it is this function and nothing
   *    on the network.
   *  - Playback position arrives by push, through onCurrentTime, so the
   *    product window needs no polling interval at all.
   */
  function buildTikTokTile(video, config, shop, widget) {
    var tile = el("div", "shopdart__tile shopdart__tile--embed", {
      "aria-label": video.title || "Shoppable video",
    });

    if (video.poster) {
      var poster = el("img", "shopdart__media shopdart__poster", {
        src: video.poster,
        alt: "",
        loading: "lazy",
        decoding: "async",
      });
      // A cover that will not load leaves a broken-image glyph over the tile.
      // Dropping it is better: the tile's own background shows through and the
      // fallback link stays legible on top of it.
      poster.addEventListener("error", function () {
        poster.remove();
      });
      tile.appendChild(poster);
    }

    var frame = null;
    var ready = false;
    var wantsPlay = false;
    var failed = false;

    var products = buildProducts(video, config, shop, widget);
    if (products) tile.appendChild(products);

    /**
     * Falls back to the cover and the product card.
     *
     * Reached when TikTok reports an error, or when the player never signals
     * ready — which is what a shopper in a country that blocks TikTok
     * experiences, and that is a large share of some merchants' traffic.
     *
     * Deliberately offers no way out to TikTok. An earlier version put a
     * "Watch on TikTok" button here, which was the one thing a shoppable
     * widget must never do: it took a shopper who was already looking at the
     * merchant's products and sent them to a different app to watch a video.
     * A sale cannot follow them there.
     *
     * What remains is a still frame from the video with the product card over
     * it, priced and buyable, because those come from our own payload rather
     * than from TikTok. The tile stops being a video and stays a storefront.
     */
    function degrade() {
      if (failed) return;
      failed = true;
      if (frame) frame.remove();
      frame = null;
      // Nothing is playing, so the poster must come back out from under
      // [data-playing].
      tile.dataset.playing = "false";
      removeEventListener("message", onMessage);
    }

    function post(type) {
      if (!frame || !frame.contentWindow) return;
      frame.contentWindow.postMessage(
        { "x-tiktok-player": true, type: type, value: undefined },
        "*"
      );
    }

    /**
     * Marks the player alive on ANY message from its frame, not only on
     * onPlayerReady.
     *
     * The timeout below tears the player down and shows the fallback, so
     * whatever decides "alive" has to be generous. Keying it solely on one
     * message type meant a single mismatch — a renamed event, a shape we did
     * not expect, a message arriving before the listener attached — would
     * destroy a working video eight seconds in. That failure is invisible
     * anywhere TikTok is blocked, because the fallback is what you see there
     * anyway, and would only appear for the shoppers it actually harms.
     *
     * Any x-tiktok-player message from this frame proves the player booted,
     * which is the only thing the timeout needs to know.
     */
    function markAlive() {
      if (ready) return;
      ready = true;
      post("mute");
      if (wantsPlay) post("play");
    }

    function onMessage(event) {
      var data = event.data;
      if (!data || data["x-tiktok-player"] !== true) return;
      // Several tiles can be on one page, so only listen to our own frame.
      if (!frame || event.source !== frame.contentWindow) return;

      markAlive();

      if (data.type === "onPlayerReady") return;

      if (data.type === "onCurrentTime") {
        if (products && products._sync && data.value) {
          products._sync(data.value.currentTime || 0);
        }
        return;
      }

      if (data.type === "onStateChange") {
        // 1 = playing, 0 = ended. Documented alongside -1 init, 2 paused,
        // 3 buffering, none of which we act on.
        if (data.value === 1) {
          // Hiding the poster is driven from here rather than from _play,
          // because [data-playing] is what fades it out and a player that
          // never loads would otherwise leave a hidden poster over a black
          // tile — which is precisely what a blocked shopper saw.
          tile.dataset.playing = "true";
          if (!tile.dataset.viewed) {
            tile.dataset.viewed = "1";
            track(shop, "VIEW_START", widget.id, video.id);
          }
        } else if (data.value === 2 || data.value === 3) {
          tile.dataset.playing = "false";
        } else if (data.value === 0) {
          track(shop, "VIEW_COMPLETE", widget.id, video.id);
        }
        return;
      }

      if (data.type === "onPlayerError") {
        // 3002 is only autoplay being refused by the browser; the video is
        // fine and the shopper can still press play.
        var code = data.value && data.value.errorCode;
        if (code !== 3002) degrade();
      }
    }

    tile._load = function () {
      if (frame || failed || !video.embedId) return;

      frame = el("iframe", "shopdart__media shopdart__embed", {
        src:
          "https://www.tiktok.com/player/v1/" +
          encodeURIComponent(video.embedId) +
          "?autoplay=0&muted=1&controls=1&progress_bar=1&loop=" +
          (config.loop !== false ? "1" : "0") +
          "&music_info=0&description=0&rel=0&native_context_menu=0",
        allow: "autoplay; encrypted-media; fullscreen",
        title: video.title || "Shoppable video",
        loading: "lazy",
        frameborder: "0",
      });
      // Attached before the frame exists, so a player that announces itself
      // immediately cannot beat the listener into place.
      addEventListener("message", onMessage);
      tile.appendChild(frame);

      // Silence means the frame never loaded — the blocked-country case, which
      // reports no error of its own. Twelve seconds rather than eight: a slow
      // mobile connection is not a blocked one, and the cost of being wrong
      // here is replacing a working video with a still image.
      setTimeout(function () {
        if (!ready) degrade();
      }, 12000);
    };

    tile._play = function () {
      wantsPlay = true;
      tile._load();
      if (ready) post("play");
      // Deliberately not setting data-playing here — see onStateChange.
    };

    tile._pause = function () {
      wantsPlay = false;
      if (ready) post("pause");
      tile.dataset.playing = "false";
    };

    return tile;
  }

  function buildTile(video, config, shop, widget) {
    // Payloads cached from before embeds existed carry no provider, and those
    // are always hosted files.
    if (video.provider === "youtube" && video.embedId) {
      return buildYouTubeTile(video, config, shop, widget);
    }
    if (video.provider === "tiktok" && video.embedId) {
      return buildTikTokTile(video, config, shop, widget);
    }
    return buildHostedTile(video, config, shop, widget);
  }

  function buildHostedTile(video, config, shop, widget) {
    var tile = el("div", "shopdart__tile", {
      role: "button",
      tabindex: "0",
      "aria-label": video.title || "Shoppable video",
    });

    if (video.poster) {
      tile.appendChild(
        el("img", "shopdart__media shopdart__poster", {
          src: video.poster,
          alt: "",
          loading: "lazy",
          decoding: "async",
        })
      );
    }

    // MP4 first. For clips of this length it reaches the first frame sooner
    // than HLS and needs no player library at all. HLS is the fallback for
    // anything long enough for adaptive bitrate to be worth the bytes.
    var file = video.mp4 || video.hls || "";

    /**
     * A hosted tile with nothing to play.
     *
     * Reachable whenever a payload written by a newer server meets a copy of
     * this script cached from before that provider existed: buildTile cannot
     * recognise the provider, falls through to here, and an empty src renders
     * a permanently blank <video> covering the poster.
     *
     * Showing the poster and the product card instead keeps the tile
     * shoppable. The products come from our own payload, not from whoever
     * hosts the video, so they work whether or not the file ever arrives.
     */
    if (!file) {
      // Nothing here responds to a press, so it must not announce itself as a
      // button. The product cards inside stay focusable on their own.
      tile.removeAttribute("role");
      tile.removeAttribute("tabindex");
      var still = buildProducts(video, config, shop, widget);
      if (still) tile.appendChild(still);
      tile._load = function () {};
      tile._play = function () {};
      tile._pause = function () {};
      return tile;
    }

    var media = el("video", "shopdart__media shopdart__video", {
      playsinline: "",
      preload: "none",
      "aria-hidden": "true",
    });
    media.muted = config.muted !== false;
    media.loop = config.loop !== false;
    tile.appendChild(media);

    var products = buildProducts(video, config, shop, widget);
    if (products) {
      tile.appendChild(products);
      if (products._sync) {
        media.addEventListener("timeupdate", function () {
          products._sync(media.currentTime || 0);
        });
      }
    }

    tile._load = function () {
      if (media.dataset.loaded) return;
      media.dataset.loaded = "1";
      media.src = file;
    };

    // [data-playing] fades the poster out, so it is set when playback really
    // begins rather than when it is requested. Asking optimistically defeated
    // the promise rejection below: a refused autoplay hid the poster anyway
    // and left the shopper looking at a stalled black frame.
    media.addEventListener("playing", function () {
      tile.dataset.playing = "true";
      if (!tile.dataset.viewed) {
        tile.dataset.viewed = "1";
        track(shop, "VIEW_START", widget.id, video.id);
      }
    });

    tile._play = function () {
      tile._load();
      var attempt = media.play();
      if (attempt && attempt.catch) {
        attempt.catch(function () {
          // Autoplay refused — leave the poster up rather than showing a
          // stalled black frame.
        });
      }
    };

    tile._pause = function () {
      media.pause();
      tile.dataset.playing = "false";
    };

    tile.addEventListener("click", function () {
      if (media.paused) tile._play();
      else tile._pause();
    });
    tile.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        tile.click();
      }
    });

    return tile;
  }

  function applyConfig(root, config) {
    root.style.setProperty("--shopdart-accent", config.accentColor);
    root.style.setProperty("--shopdart-accent-text", config.accentTextColor);
    root.style.setProperty("--shopdart-radius", config.cornerRadius + "px");
    root.style.setProperty("--shopdart-ratio", ratioValue(config.aspectRatio));
    root.style.setProperty("--shopdart-per-row", config.itemsPerRow);
  }

  function observe(tiles, config) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var tile = entry.target;
          if (entry.isIntersecting) {
            tile._load();
            if (config.autoplay !== false) tile._play();
            if (!tile.dataset.impressed) {
              tile.dataset.impressed = "1";
              tile._impression();
            }
          } else {
            tile._pause();
          }
        });
      },
      // Start fetching slightly before the tile is on screen so playback
      // begins the moment it arrives, without preloading the whole page.
      { rootMargin: "200px 0px", threshold: 0.25 }
    );
    tiles.forEach(function (tile) {
      observer.observe(tile);
    });
    return observer;
  }

  function renderWidget(root, widget, shop, watermark) {
    var config = widget.config;
    applyConfig(root, config);

    var container = el("div", null);

    if (config.heading) {
      var heading = el("h2", "shopdart__heading");
      heading.textContent = config.heading;
      container.appendChild(heading);
    }

    var tiles = [];

    if (widget.layout === "STORIES") {
      var bar = el("div", "shopdart__stories");
      widget.videos.forEach(function (video) {
        var story = el("button", "shopdart__story", { type: "button" });
        if (video.poster) {
          story.appendChild(
            el("img", null, { src: video.poster, alt: "", loading: "lazy" })
          );
        }
        var label = el("span");
        label.textContent = video.title || "";
        story.appendChild(label);
        story.addEventListener("click", function () {
          openLightbox(video, config, shop, widget);
        });
        bar.appendChild(story);
      });
      container.appendChild(bar);
    } else {
      var list = el(
        "div",
        widget.layout === "GALLERY" ? "shopdart__grid" : "shopdart__rail"
      );
      widget.videos.forEach(function (video) {
        var tile = buildTile(video, config, shop, widget);
        tile._impression = function () {
          track(shop, "IMPRESSION", widget.id, video.id);
        };
        tiles.push(tile);
        list.appendChild(tile);
      });
      container.appendChild(list);
    }

    if (watermark) container.appendChild(buildWatermark());

    root.appendChild(container);
    if (tiles.length) observe(tiles, config);
  }

  function openLightbox(video, config, shop, widget) {
    var overlay = el("div", "shopdart__lightbox shopdart");
    applyConfig(overlay, config);

    var tile = buildTile(video, config, shop, widget);
    tile._impression = function () {};
    overlay.appendChild(tile);

    var close = el("button", "shopdart__close", {
      type: "button",
      "aria-label": "Close",
    });
    close.textContent = "×";
    close.addEventListener("click", function () {
      overlay.remove();
      flush(shop);
    });
    tile.appendChild(close);

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        overlay.remove();
        flush(shop);
      }
    });

    document.body.appendChild(overlay);
    track(shop, "IMPRESSION", widget.id, video.id);
    tile._play();
  }

  function renderFloating(root, widget, shop) {
    var video = widget.videos[0];
    if (!video) return;
    var config = widget.config;

    var host = el("div", "shopdart__floating", {
      "data-position": config.position || "bottom-right",
    });
    applyConfig(host, config);

    var tile = buildTile(video, config, shop, widget);
    tile._impression = function () {
      track(shop, "IMPRESSION", widget.id, video.id);
    };
    host.appendChild(tile);

    var close = el("button", "shopdart__close", {
      type: "button",
      "aria-label": "Close video",
    });
    close.textContent = "×";
    close.addEventListener("click", function (event) {
      event.stopPropagation();
      host.remove();
      try {
        sessionStorage.setItem("shopdart_float_closed", "1");
      } catch (error) {
        /* storage blocked (private mode) — not worth surfacing */
      }
      flush(shop);
    });
    host.appendChild(close);

    document.body.appendChild(host);
    observe([tile], config);
  }

  // ---------------------------------------------------------------- boot ---

  function matches(widget, target, productGid, collectionGid) {
    return widget.placements.some(function (placement) {
      if (placement.target === "ALL_PAGES") return true;
      if (placement.target !== target) return false;
      if (!placement.ref) return true;
      return placement.ref === productGid || placement.ref === collectionGid;
    });
  }

  function mount(root) {
    if (root.dataset.mounted) return;
    root.dataset.mounted = "1";

    var shop = root.dataset.shop;
    if (!shop) return;

    var target = PAGE_TO_TARGET[root.dataset.page] || "CUSTOM";
    var allowed = (root.dataset.layouts || "").split(",");
    var pinned = root.dataset.widget;

    loadPayload(shop).then(function (payload) {
      var skeleton = root.querySelector(".shopdart__skeleton");
      if (skeleton) skeleton.remove();
      if (!payload || !payload.widgets) return;

      CURRENCY = payload.currency || null;

      var due = payload.widgets.filter(function (widget) {
        if (allowed.indexOf(widget.layout) === -1) return false;
        if (pinned) return widget.id === pinned;
        return matches(
          widget,
          target,
          root.dataset.product,
          root.dataset.collection
        );
      });

      if (!due.length) {
        // Collapse entirely rather than leaving an empty padded box behind.
        root.style.display = "none";
        return;
      }

      root.hidden = false;

      due.forEach(function (widget) {
        if (widget.layout === "FLOATING") {
          var closed = false;
          try {
            closed = sessionStorage.getItem("shopdart_float_closed") === "1";
          } catch (error) {
        /* storage blocked (private mode) — not worth surfacing */
      }
          if (!closed) renderFloating(root, widget, shop);
        } else if (widget.layout === "POPUP") {
          // Popups open from a stories tap; nothing renders inline.
        } else {
          renderWidget(root, widget, shop, payload.watermark);
        }
      });

      var send = function () {
        flush(shop);
      };
      addEventListener("pagehide", send);
      addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") send();
      });
    });
  }

  function boot() {
    document.querySelectorAll("[data-shopdart]").forEach(mount);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Theme editor re-renders sections without a page load.
  document.addEventListener("shopify:section:load", boot);
})();
