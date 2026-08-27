import "./perf-metrics-panel.js";

const plugin = {
  apiVersion: 2,
  name: "Performance Metrics",
  activate: ({ pluginId, html, svg }) => {
    return {
      contributions: {
        workspacePanels: [
          {
            id: "workspace.perf-metrics",
            title: "Performance",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 3v18h18"></path>
                <path d="M7 16l4-6 4 4 5-8"></path>
              </svg>
            `,
            order: 50,
            render: (context) =>
              html`<perf-metrics-panel .context=${context}></perf-metrics-panel>`,
          },
        ],
      },
    };
  },
};

export default plugin;
