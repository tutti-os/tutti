import { motion } from "framer-motion";
import type { AgentGUIAgentAvatarPresentation } from "./model/agentGuiAgentAvatarPresentation";
import { isBetaAgentProvider } from "../../shared/managedAgentProviders";
import chassisAssetUrl from "../../app/renderer/assets/icons/agent-vinyl-player-chassis.png";
import tonearmAssetUrl from "../../app/renderer/assets/icons/agent-vinyl-tonearm.png";
import betaTagAssetUrl from "../../app/renderer/assets/icons/agent-vinyl-beta-tag.svg";

interface AgentGUIVinylPlayerProps {
  selectedAgent: AgentGUIAgentAvatarPresentation | null;
  isPlaying: boolean;
}

/**
 * Directly ported from the retro-vinyl-player reference component and scaled
 * by the stylesheet for the compact AgentGUI hero slot.
 */
export function AgentGUIVinylPlayer({
  selectedAgent,
  isPlaying
}: AgentGUIVinylPlayerProps): React.JSX.Element {
  const selectedAgentCover = selectedAgent?.iconUrl ?? null;
  const showBetaBadge = isBetaAgentProvider(selectedAgent?.provider);

  return (
    <div className="agent-gui-vinyl-player" aria-hidden="true">
      {showBetaBadge ? (
        <img
          className="agent-gui-vinyl-player__beta"
          src={betaTagAssetUrl}
          alt=""
        />
      ) : null}
      <img
        className="agent-gui-vinyl-player__chassis"
        src={chassisAssetUrl}
        alt=""
      />
      <div className="agent-gui-vinyl-player__indicator">
        <div
          className={`agent-gui-vinyl-player__indicator-light${
            isPlaying ? " agent-gui-vinyl-player__indicator-light--playing" : ""
          }`}
        >
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="agent-gui-vinyl-player__platter">
        <div className="agent-gui-vinyl-player__platter-inner">
          <motion.div
            className="agent-gui-vinyl-player__record"
            animate={{ rotate: isPlaying ? 360 : 0 }}
            transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
          >
            {Array.from({ length: 18 }, (_, index) => (
              <span
                key={index}
                className="agent-gui-vinyl-player__groove"
                style={{ inset: `${10 + index * 4.5}px` }}
              />
            ))}
            <span className="agent-gui-vinyl-player__reflection" />
            <span className="agent-gui-vinyl-player__label">
              {selectedAgentCover ? (
                <img src={selectedAgentCover} alt="" />
              ) : null}
            </span>
          </motion.div>
        </div>
      </div>
      <img
        className="agent-gui-vinyl-player__tonearm"
        src={tonearmAssetUrl}
        alt=""
      />
      <div className="agent-gui-vinyl-player__power-control">
        <motion.span
          className="agent-gui-vinyl-player__lever"
          animate={{ rotate: isPlaying ? 25 : -25 }}
          transition={{ type: "spring", stiffness: 200, damping: 15 }}
        />
      </div>
      <div className="agent-gui-vinyl-player__tone-control">
        <span />
        <span>◦</span>
      </div>
      {selectedAgent?.badge?.iconUrl ? (
        <span
          className="agent-gui-vinyl-player__owner-badge"
          data-agent-owner-badge="true"
        >
          <img src={selectedAgent.badge.iconUrl} alt="" draggable={false} />
        </span>
      ) : null}
    </div>
  );
}
