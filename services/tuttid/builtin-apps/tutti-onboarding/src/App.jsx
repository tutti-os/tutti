import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import i18n from "./i18n";
import { useAppLocale } from "./i18n/app-context";
import { reportUserActiveOnce } from "./tutti-activity.js";

const agentTabs = [
  { label: "Claude Code", image: "/assets/bind-claude.webp", altKey: "t_s1a" },
  { label: "Codex", image: "/assets/bind-codex.webp", altKey: "t_s1b" },
  { label: "Hermes Agent", soon: true },
  { label: "OpenClaw", soon: true },
  { label: "Gemini", soon: true }
];

const atTabs = [
  { labelKey: "t_at1", image: "/assets/at-chat.webp", altKey: "t_atd1" },
  { labelKey: "t_at2", image: "/assets/at-file.webp", altKey: "t_atd2" },
  { labelKey: "t_at3", image: "/assets/at-task.webp", altKey: "t_atd3" },
  { labelKey: "t_at4", image: "/assets/at-app.webp", altKey: "t_atd4" }
];

const appTabs = [
  {
    labelKey: "t_apt1",
    image: "/assets/apps-overview.webp",
    altKey: "t_apd1"
  },
  {
    labelKey: "t_apt2",
    image: "/assets/apps-example.webp",
    altKey: "t_apd2"
  },
  {
    labelKey: "t_apt3",
    image: "/assets/apps-example-prototype.webp",
    altKey: "t_apd3"
  },
  {
    labelKey: "t_apt4",
    image: "/assets/apps-example-docs.webp",
    altKey: "t_apd4"
  }
];

const taskControlTabs = [
  {
    labelKey: "t_tc_tab1",
    image: "/assets/goal-breakdown.webp",
    altKey: "t_tc_img1"
  },
  {
    labelKey: "t_tc_tab2",
    image: "/assets/control-overview.webp",
    altKey: "t_tc_img2"
  }
];

const sectionIcons = {
  setup: "/assets/icon-electric-plug.webp",
  collaboration: "/assets/icon-at.png",
  apps: "/assets/icon-toolbox.webp",
  taskControl: "/assets/icon-clipboard.webp"
};

function HtmlText({ as: Tag = "p", className, i18nKey }) {
  return (
    <Tag className={className}>
      <Trans
        components={{
          bold: <b />,
          br: <br />,
          dot: <span className="info-dot" />,
          info: <span className="info-wrap" />,
          tip: <span className="info-tip" />,
          wave: (
            <img
              alt=""
              aria-hidden="true"
              className="title-wave"
              src="/assets/tone-light.webp"
            />
          )
        }}
        i18nKey={i18nKey}
      />
    </Tag>
  );
}

function IconImage({ alt = "", className, src }) {
  return <img alt={alt} className={className} src={src} />;
}

function openAction(action, provider) {
  const workspace = window.tuttiExternal?.workspace;
  if (typeof workspace?.openFeature !== "function") return Promise.resolve();

  if (action === "agent-connect") {
    return workspace.openFeature({
      feature: "agent-connect",
      provider: provider || "codex"
    });
  }

  if (action === "agent-chat") {
    return workspace.openFeature({ feature: "agent-chat" });
  }

  if (
    action === "app-center" ||
    action === "issue-manager" ||
    action === "message-center"
  ) {
    return workspace.openFeature({ feature: action });
  }

  return Promise.resolve();
}

function ActionButton({ action, children, className, provider }) {
  return (
    <button
      className={className}
      data-action={action}
      data-provider={provider}
      type="button"
      onClick={() => {
        openAction(action, provider).catch(() => {});
      }}
    >
      <span>{children}</span>
    </button>
  );
}

function ShotImage({ altKey, onOpen, src }) {
  const { t } = useTranslation();
  const alt = t(altKey);

  return (
    <button
      className="shot"
      type="button"
      onClick={() => {
        onOpen(src, alt);
      }}
    >
      <img alt={alt} src={src} />
    </button>
  );
}

function SegmentBar({ active, items, onChange }) {
  const tabBarRef = useRef(null);
  const tabRefs = useRef([]);

  const updateSlider = () => {
    const tabBar = tabBarRef.current;
    const activeTab = tabRefs.current[active];
    if (!tabBar || !activeTab) return;

    tabBar.style.setProperty("--segment-slider-x", `${activeTab.offsetLeft}px`);
    tabBar.style.setProperty(
      "--segment-slider-width",
      `${activeTab.offsetWidth}px`
    );
  };

  useLayoutEffect(() => {
    updateSlider();
  });

  useEffect(() => {
    window.addEventListener("resize", updateSlider);
    return () => {
      window.removeEventListener("resize", updateSlider);
    };
  }, [active]);

  return (
    <div className="segment-bar" ref={tabBarRef}>
      {items.map((item, index) => {
        const isActive = active === index && !item.soon;

        return (
          <button
            aria-disabled={item.soon ? "true" : undefined}
            className={`segment-btn${isActive ? " on" : ""}${item.soon ? " soon" : ""}`}
            data-soon={item.soonLabel}
            key={`${item.label}-${index}`}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            onClick={() => {
              if (!item.soon) onChange(index);
            }}
          >
            {item.icon ? <span>{item.icon}</span> : null}
            <b>{item.label}</b>
          </button>
        );
      })}
    </div>
  );
}

function Tabs({ initialActive = 0, items, onOpen, variant = "underline" }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(initialActive);

  return (
    <div className={`tabs tabs-${variant}`} data-tabs>
      {variant === "segment" ? (
        <SegmentBar
          active={active}
          items={items.map((item) => ({
            label: item.label || t(item.labelKey),
            soon: item.soon,
            soonLabel: item.soon ? t("t_soon") : undefined
          }))}
          onChange={setActive}
        />
      ) : (
        <div className="tab-bar">
          {items.map((item, index) => (
            <button
              className={`tab-btn${active === index ? " on" : ""}${item.soon ? " soon" : ""}`}
              data-soon={item.soon ? t("t_soon") : undefined}
              data-t={item.soon ? undefined : index}
              key={`${item.label || item.labelKey}-${index}`}
              type="button"
              onClick={() => {
                if (!item.soon) setActive(index);
              }}
            >
              <span>{item.label || t(item.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
      {items
        .filter((item) => !item.soon)
        .map((item, index) => (
          <div
            className={`tab-pane${active === index ? " on" : ""}`}
            key={item.image || item.altKey}
          >
            <ShotImage altKey={item.altKey} onOpen={onOpen} src={item.image} />
          </div>
        ))}
    </div>
  );
}

function SectionTabs({ active, items, onChange }) {
  const { t } = useTranslation();

  return (
    <SegmentBar
      active={active}
      items={items.map((item) => ({
        icon: item.icon,
        label: t(item.labelKey)
      }))}
      onChange={onChange}
    />
  );
}

function VideoPane() {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef(null);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  return (
    <div className={`shot shot-video${playing ? " playing" : ""}`}>
      <video
        aria-label={t("t_agd1")}
        controls
        controlsList="nodownload"
        loop
        muted
        playsInline
        preload="metadata"
        ref={videoRef}
        src="/assets/apps-agent.mp4"
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
      />
      <button
        aria-label={t("t_play_pause")}
        className="video-play"
        type="button"
        onClick={toggle}
      >
        <span>▶</span>
      </button>
    </div>
  );
}

function AgentAppTabs({ onOpen }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const items = [
    { labelKey: "t_agt1", pane: <VideoPane /> },
    {
      labelKey: "t_agt2",
      pane: (
        <ShotImage
          altKey="t_agd2"
          onOpen={onOpen}
          src="/assets/apps-output-reference.webp"
        />
      )
    }
  ];

  return (
    <div className="tabs" data-tabs>
      <div className="tab-bar">
        {items.map((item, index) => (
          <button
            className={`tab-btn${active === index ? " on" : ""}`}
            data-t={index}
            key={item.labelKey}
            type="button"
            onClick={() => setActive(index)}
          >
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
      </div>
      {items.map((item, index) => (
        <div
          className={`tab-pane${active === index ? " on" : ""}`}
          key={item.labelKey}
        >
          {item.pane}
        </div>
      ))}
    </div>
  );
}

function Lightbox({ image, onClose }) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!image) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [image, onClose]);

  return (
    <div
      className="lightbox"
      hidden={!image}
      id="lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <img
        alt={image?.alt || ""}
        className="lightbox-img"
        id="lightboxImg"
        src={image?.src || ""}
      />
      <button
        aria-label={t("t_close")}
        className="lightbox-close"
        id="lightboxClose"
        type="button"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const locale = useAppLocale();
  const [activeSection, setActiveSection] = useState("s1");
  const [section3Tab, setSection3Tab] = useState(0);
  const [agentBound, setAgentBound] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [isNavStuck, setIsNavStuck] = useState(false);
  const navRef = useRef(null);
  const navSentinelRef = useRef(null);
  const isNavStuckRef = useRef(false);

  useEffect(() => {
    reportUserActiveOnce();
  }, []);

  useEffect(() => {
    const app = window.tuttiExternal?.app;
    if (!app) return;
    const updateBound = (ctx) => {
      if (ctx && typeof ctx.agentBound === "boolean") {
        setAgentBound(ctx.agentBound);
      }
    };
    void app
      .getContext()
      .then(updateBound)
      .catch(() => {});
    const unsubscribe = app.subscribe(updateBound);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    void i18n.changeLanguage(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    document.title = t("t_doc_title");
  }, [t]);

  useEffect(() => {
    for (const img of document.querySelectorAll(".shot img")) {
      const source = img.currentSrc || img.getAttribute("src");
      if (!source) continue;
      const preload = new Image();
      preload.decoding = "async";
      preload.src = source;
      if (typeof preload.decode === "function") {
        preload.decode().catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    let frame = 0;

    const updateActiveSection = () => {
      frame = 0;
      const sections = [...document.querySelectorAll(".sec")];
      if (!sections.length) return;

      const navBottom = navRef.current?.getBoundingClientRect().bottom || 0;
      const sectionOffset =
        Number.parseFloat(getComputedStyle(sections[0]).scrollMarginTop) || 0;
      const activationLine = Math.max(navBottom + 8, sectionOffset + 1);
      let nextActive = sections[0].id;

      for (const section of sections) {
        if (section.getBoundingClientRect().top <= activationLine) {
          nextActive = section.id;
        } else {
          break;
        }
      }

      const pageBottom = window.scrollY + window.innerHeight;
      const documentHeight = document.documentElement.scrollHeight;
      if (pageBottom >= documentHeight - 2) {
        nextActive = sections.at(-1).id;
      }

      setActiveSection((current) =>
        current === nextActive ? current : nextActive
      );
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateActiveSection);
    };

    scheduleUpdate();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, []);

  useEffect(() => {
    let frame = 0;

    const updateNavStuck = () => {
      frame = 0;
      const sentinel = navSentinelRef.current;
      if (!sentinel) return;

      const shouldStick = sentinel.getBoundingClientRect().top <= 0;

      if (shouldStick === isNavStuckRef.current) return;
      isNavStuckRef.current = shouldStick;
      setIsNavStuck(shouldStick);
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateNavStuck);
    };

    scheduleUpdate();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, []);

  const openLightbox = (src, alt) => setLightbox({ src, alt });
  const closeLightbox = () => setLightbox(null);
  const navItems = [
    {
      id: "s1",
      icon: sectionIcons.setup,
      labelKey: "t_n1",
      tone: "var(--accent-codex)"
    },
    {
      id: "s2",
      icon: sectionIcons.collaboration,
      labelKey: "t_n2",
      tone: "var(--accent-claude)"
    },
    {
      id: "s3",
      icon: sectionIcons.apps,
      labelKey: "t_n3",
      tone: "var(--tutti-purple)"
    },
    {
      id: "s4",
      icon: sectionIcons.taskControl,
      labelKey: "t_n4",
      tone: "var(--accent-claude)"
    }
  ];

  return (
    <>
      <main className="page">
        <header className="hero">
          <HtmlText as="h1" i18nKey="t_title" />
          <HtmlText className="tag" i18nKey="t_tag" />
        </header>

        <div aria-hidden="true" className="nav-sentinel" ref={navSentinelRef} />
        <nav
          aria-label={t("t_nav_label")}
          className={`nav${isNavStuck ? " stuck" : ""}`}
          ref={navRef}
        >
          {navItems.map((item) => (
            <button
              className={`nav-btn${activeSection === item.id ? " on" : ""}`}
              data-scroll={item.id}
              key={item.id}
              style={{ "--tone": item.tone }}
              type="button"
              onClick={() => {
                setActiveSection(item.id);
                document
                  .getElementById(item.id)
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              <IconImage className="nav-ico" src={item.icon} />
              <b className="nav-title">{t(item.labelKey)}</b>
            </button>
          ))}
        </nav>

        {/* Section 1: Agent sign-in */}
        <section
          className="sec"
          id="s1"
          style={{
            "--tone": "var(--accent-codex)",
            "--tone-fg": "var(--white-stationary)"
          }}
        >
          <div className="sec-h">
            <IconImage className="sec-ico" src={sectionIcons.setup} />
            <h2>{t("t_h1")}</h2>
          </div>
          <HtmlText className="sec-intro" i18nKey="t_i1" />
          <Tabs items={agentTabs} onOpen={openLightbox} variant="segment" />
          <div className="btns">
            <ActionButton
              action="agent-connect"
              className="btn ghost"
              provider="claude-code"
            >
              {t("t_b1a")}
            </ActionButton>
            <ActionButton
              action="agent-connect"
              className="btn ghost"
              provider="codex"
            >
              {t("t_b1b")}
            </ActionButton>
          </div>
        </section>

        {/* Section 2: Big @ collaboration */}
        <section
          className="sec"
          id="s2"
          style={{
            "--tone": "var(--accent-claude)",
            "--tone-fg": "var(--white-stationary)"
          }}
        >
          <div className="sec-h">
            <IconImage className="sec-ico" src={sectionIcons.collaboration} />
            <h2>{t("t_h2")}</h2>
          </div>
          <HtmlText className="sec-intro" i18nKey="t_atdesc" />
          <div className="sec-panes">
            <div className="sec-pane on">
              <Tabs
                initialActive={0}
                items={atTabs}
                onOpen={openLightbox}
                variant="segment"
              />
            </div>
          </div>
        </section>

        {/* Section 3: Built-in apps */}
        <section
          className="sec"
          id="s3"
          style={{
            "--tone": "var(--tutti-purple)",
            "--tone-fg": "var(--white-stationary)"
          }}
        >
          <div className="sec-h">
            <IconImage className="sec-ico" src={sectionIcons.apps} />
            <h2>{t("t_h3")}</h2>
          </div>
          <HtmlText
            className="sec-intro"
            i18nKey={section3Tab === 0 ? "t_appdesc" : "t_agappdesc"}
          />
          <SectionTabs
            active={section3Tab}
            items={[{ labelKey: "t_st3" }, { labelKey: "t_st4" }]}
            onChange={setSection3Tab}
          />
          <div className="sec-panes">
            <div className={`sec-pane${section3Tab === 0 ? " on" : ""}`}>
              <Tabs items={appTabs} onOpen={openLightbox} />
              <div className="btns">
                <ActionButton action="app-center" className="btn ghost">
                  {t("t_bg3")}
                </ActionButton>
              </div>
            </div>
            <div className={`sec-pane${section3Tab === 1 ? " on" : ""}`}>
              <AgentAppTabs onOpen={openLightbox} />
            </div>
          </div>
        </section>

        {/* Section 4: Tasks and control */}
        <section
          className="sec"
          id="s4"
          style={{
            "--tone": "var(--accent-claude)",
            "--tone-fg": "var(--white-stationary)"
          }}
        >
          <div className="sec-h">
            <IconImage className="sec-ico" src={sectionIcons.taskControl} />
            <h2>{t("t_h4")}</h2>
          </div>
          <HtmlText className="sec-intro" i18nKey="t_h4_desc" />
          <Tabs
            items={taskControlTabs}
            onOpen={openLightbox}
            variant="segment"
          />
          <div className="btns">
            <ActionButton action="issue-manager" className="btn ghost">
              {t("t_bg4a")}
            </ActionButton>
            <ActionButton action="message-center" className="btn ghost">
              {t("t_bg4b")}
            </ActionButton>
          </div>
        </section>

        <footer className="end">
          <IconImage
            alt="Tutti"
            className="end-logo"
            src="/assets/logo1.webp"
          />
          <h2>{t("t_end")}</h2>
          <div className="btns center">
            {agentBound ? (
              <ActionButton action="agent-chat" className="btn blue">
                {t("t_be2")}
              </ActionButton>
            ) : (
              <ActionButton
                action="agent-connect"
                className="btn blue"
                provider="codex"
              >
                {t("t_be1")}
              </ActionButton>
            )}
          </div>
        </footer>
      </main>
      <Lightbox image={lightbox} onClose={closeLightbox} />
    </>
  );
}
