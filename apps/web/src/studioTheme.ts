import * as Blockly from "blockly/core";
export const theme = Blockly.Theme.defineTheme("studio", {
  name: "studio",
  base: Blockly.Themes.Classic,
  componentStyles: {
    workspaceBackgroundColour: "#f6f7f5",
    toolboxBackgroundColour: "#ffffff",
    toolboxForegroundColour: "#545e58",
    flyoutBackgroundColour: "#ecefeb",
    flyoutForegroundColour: "#243b30",
    flyoutOpacity: 1,
    scrollbarColour: "#c2cac3",
    scrollbarOpacity: 0.5,
    insertionMarkerColour: "#4e7963",
    insertionMarkerOpacity: 0.3,
    cursorColour: "#2b5c43",
  },
  fontStyle: { family: "DM Sans", weight: "500", size: 11 },
  startHats: false,
});
