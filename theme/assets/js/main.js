/**
 * The theme's only script: the small-screen menu and the contact form.
 *
 * Both are progressive enhancements — the menu is reachable without this (the
 * links are in the footer too) and the form falls back to the mailto: link
 * printed next to the button. No framework, no build step: ~90 lines beat a
 * bundler for two behaviours.
 */
(function () {
  "use strict";

  /* ----------------------------------------------------------------- menu */
  var toggle = document.getElementById("menu-toggle");
  var menu = document.getElementById("site-menu");

  if (toggle && menu) {
    var setOpen = function (open) {
      menu.classList.toggle("hidden", !open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      document.documentElement.classList.toggle("overflow-hidden", open);
      if (open) {
        var first = menu.querySelector("a, button");
        if (first) first.focus();
      }
    };

    toggle.addEventListener("click", function () {
      setOpen(menu.classList.contains("hidden"));
    });

    Array.prototype.forEach.call(menu.querySelectorAll("[data-menu-close]"), function (el) {
      el.addEventListener("click", function () {
        setOpen(false);
        toggle.focus();
      });
    });

    Array.prototype.forEach.call(menu.querySelectorAll("a"), function (el) {
      el.addEventListener("click", function () {
        setOpen(false);
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !menu.classList.contains("hidden")) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  /* ----------------------------------------------------------- contact form
     The labels and the limits are the ones the original Contact Form 7 form
     used. Validation matches the field markup: nothing is sent anywhere, the
     message is composed and handed to the visitor's mail client. */
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var REQUIRED = { Naam: true, Email: true, Onderwerp: true, Bericht: true };

  var forms = document.querySelectorAll("[data-contact-form]");
  Array.prototype.forEach.call(forms, function (form) {
    var mailto = form.getAttribute("data-mailto");
    var status = form.querySelector("[data-form-status]");

    var field = function (name) {
      return form.querySelector('[name="' + name + '"]');
    };

    var showError = function (name, message) {
      var slot = form.querySelector('[data-error-for="' + name + '"]');
      var input = field(name);
      if (slot) {
        slot.textContent = message || "";
        slot.classList.toggle("hidden", !message);
      }
      if (input) {
        if (message) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      }
    };

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var value = function (name) {
        var input = field(name);
        return input ? String(input.value).trim() : "";
      };

      var errors = {};
      if (!value("Naam")) errors.Naam = "Vul uw naam in.";
      if (!value("Email")) errors.Email = "Vul uw e-mailadres in.";
      else if (!EMAIL.test(value("Email"))) errors.Email = "Dit lijkt geen geldig e-mailadres.";
      if (!value("Onderwerp")) errors.Onderwerp = "Vul een onderwerp in.";
      if (value("Bericht").length < 10) errors.Bericht = "Vul een bericht van minimaal 10 tekens in.";

      ["Naam", "Email", "Mobiel", "Onderwerp", "Bericht"].forEach(function (name) {
        showError(name, errors[name] || "");
      });

      if (Object.keys(errors).length) {
        if (status) status.classList.add("hidden");
        var firstInvalid = field(Object.keys(errors)[0]);
        if (firstInvalid) firstInvalid.focus();
        return;
      }

      var body = [
        "Naam: " + value("Naam"),
        "Email: " + value("Email"),
        "Mobiel: " + value("Mobiel"),
        "",
        value("Bericht"),
      ].join("\n");

      window.location.href =
        "mailto:" +
        mailto +
        "?subject=" +
        encodeURIComponent(value("Onderwerp")) +
        "&body=" +
        encodeURIComponent(body);

      if (status) {
        status.textContent =
          "Uw e-mailprogramma is geopend met dit bericht. Komt er niets tevoorschijn, mail dan direct naar " +
          mailto +
          " of bel het kantoor.";
        status.classList.remove("hidden");
      }
    });
  });
})();
