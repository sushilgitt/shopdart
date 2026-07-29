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
  }

  function flush(shop) {
    if (!queue.length) return;
    var body = JSON.stringify({ shop: shop, events: queue.splice(0, 50) });
    // sendBeacon survives the page unloading; fetch does not.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        ORIGIN + "/api/events",
        new Blob([body], { type: "application/json" })
      );
    } else {
      fetch(ORIGIN + "/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  function money(amount) {
    if (amount === null || amount === undefined) return "";
    try {
      return amount.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch (error) {
      return String(amount);
    }
  }

  function buildProducts(video, config, shop, widget) {
    if (!config.showProductCard || !video.products.length) return null;
    var wrap = el("div", "shopdart__products");

    video.products.slice(0, 2).forEach(function (product) {
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
      if (product.price !== null) {
        var price = el("span", "shopdart__product-price");
        price.textContent = money(product.price);
        text.appendChild(price);
      }
      card.appendChild(text);

      if (product.variantId) {
        var button = el("button", "shopdart__cta", { type: "button" });
        button.textContent = config.ctaLabel || "Shop now";
        button.addEventListener("click", function (event) {
          event.stopPropagation();
          event.preventDefault();
          track(shop, "PRODUCT_CLICK", widget.id, video.id, product.id);
          addToCart(product.variantId, button, function () {
            stampCart(video.id, widget.id);
            track(shop, "ADD_TO_CART", widget.id, video.id, product.id);
            flush(shop);
          });
        });
        card.appendChild(button);
      } else if (product.handle) {
        // Multi-variant products need the shopper to choose, so send them to
        // the product page rather than guessing a size for them.
        var link = el("a", "shopdart__cta", { href: "/products/" + product.handle });
        link.textContent = "View";
        link.addEventListener("click", function (event) {
          event.stopPropagation();
          track(shop, "PRODUCT_CLICK", widget.id, video.id, product.id);
          flush(shop);
        });
        card.appendChild(link);
      }

      wrap.appendChild(card);
    });

    return wrap;
  }

  function buildTile(video, config, shop, widget) {
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

    var media = el("video", "shopdart__media shopdart__video", {
      playsinline: "",
      preload: "none",
      "aria-hidden": "true",
    });
    media.muted = config.muted !== false;
    media.loop = config.loop !== false;
    tile.appendChild(media);

    var products = buildProducts(video, config, shop, widget);
    if (products) tile.appendChild(products);

    tile._load = function () {
      if (media.dataset.loaded) return;
      media.dataset.loaded = "1";
      // MP4 first. For clips of this length it reaches the first frame sooner
      // than HLS and needs no player library at all. HLS is the fallback for
      // anything long enough for adaptive bitrate to be worth the bytes.
      media.src = video.mp4 || video.hls || "";
    };

    tile._play = function () {
      tile._load();
      var attempt = media.play();
      if (attempt && attempt.catch) {
        attempt.catch(function () {
          // Autoplay refused — leave the poster up rather than showing a
          // stalled black frame.
        });
      }
      tile.dataset.playing = "true";
      if (!tile.dataset.viewed) {
        tile.dataset.viewed = "1";
        track(shop, "VIEW_START", widget.id, video.id);
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

  function renderWidget(root, widget, shop) {
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
          renderWidget(root, widget, shop);
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
