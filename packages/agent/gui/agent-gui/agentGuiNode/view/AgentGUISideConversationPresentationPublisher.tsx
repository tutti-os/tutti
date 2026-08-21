import { Component } from "react";
import type {
  AgentGUISideConversationPresentation,
  AgentGUISideConversationProjection
} from "../../../agentSideConversationPresentation";

interface AgentGUISideConversationPresentationPublisherProps {
  presentation: AgentGUISideConversationPresentation;
  projection: AgentGUISideConversationProjection | null;
  sourceMismatch: boolean;
  onClose(): Promise<void>;
}

export class AgentGUISideConversationPresentationPublisher extends Component<AgentGUISideConversationPresentationPublisherProps> {
  componentDidMount(): void {
    this.publish();
  }

  componentDidUpdate(
    previous: AgentGUISideConversationPresentationPublisherProps
  ): void {
    if (previous.presentation !== this.props.presentation) {
      previous.presentation.publish(null);
    }
    if (
      previous.presentation !== this.props.presentation ||
      previous.projection !== this.props.projection
    ) {
      this.publish();
    } else if (!previous.sourceMismatch && this.props.sourceMismatch) {
      this.closeMismatchedSide();
    }
  }

  componentWillUnmount(): void {
    this.props.presentation.publish(null);
  }

  render(): null {
    return null;
  }

  private publish(): void {
    this.props.presentation.publish(this.props.projection);
    this.closeMismatchedSide();
  }

  private closeMismatchedSide(): void {
    if (this.props.sourceMismatch) {
      void this.props.onClose().catch(() => {});
    }
  }
}
