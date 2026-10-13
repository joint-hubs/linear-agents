// PanelBoundary — a React error boundary around one Cockpit panel. A render
// error inside a panel (e.g. an unexpected item shape from /api/cockpit) must
// cost the panel, not the page: without a boundary React unmounts the whole
// tree and the Cockpit renders blank. Shows a compact error card — the fixed
// sentence (never colour alone), the error message in muted text and a Retry
// button that resets the boundary so the children render again fresh.
//
// Only the immediate children subtree is guarded; errors thrown in event
// handlers or async callbacks are NOT caught by React boundaries (the panel's
// own error state handles those).

import { Component } from 'react';

export default class PanelBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  retry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const message = error && error.message ? error.message : String(error);
    return (
      <div className="section" role="alert">
        <div className="section-h">{this.props.label || 'Panel'}</div>
        <div className="banner banner-warn">
          <div>This panel failed to render — the rest of the Cockpit still works.</div>
          <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>{message}</div>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn-secondary" onClick={this.retry}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }
}
