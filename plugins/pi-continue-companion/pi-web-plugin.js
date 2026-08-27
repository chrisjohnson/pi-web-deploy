import { CONTINUE_ROOT } from "./continueDiscovery.js";
import { defineContinuePanelElement } from "./continuePanelElement.js";

const plugin = {
  apiVersion: 1,
  name: "Continue Companion",
  activate: ({ pluginId, html, svg }) => {
    defineContinuePanelElement();
    return {
      contributions: {
        actions: [
          {
            id: "workspace.open-continue-companion",
            title: "Open Continue Handoffs",
            description: `Open the workspace Continue Handoffs tab. Handoffs live in ${CONTINUE_ROOT}.`,
            group: "Workspace",
            enabled: (context) => context.state.selectedWorkspace !== undefined,
            run: (context) => {
              if (context.state.selectedWorkspace === undefined) return;
              context.selectWorkspaceTool(`${pluginId}:workspace.continue-companion`);
            },
          },
        ],
        workspacePanels: [
          {
            id: "workspace.continue-companion",
            title: "Continue",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 8v4l3 3"></path>
                <circle cx="12" cy="12" r="9"></circle>
              </svg>
            `,
            order: 60,
            render: (context) => html`<pi-web-continue-companion-panel .context=${context}></pi-web-continue-companion-panel>`,
          },
        ],
      },
    };
  },
};

export default plugin;
