/**
 * The left column's glyph for the plugin's page.
 *
 * The sidebar draws the panel list's rows itself — an icon plus, in the wide
 * column, the row's label — so this component only renders the glyph.
 */
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';

export type TrackerPanelIconProps = PropsRuntime<'sidebar.panellist'>;

/**
 * Render the panel glyph.
 * @param props - The sidebar's icon share (the requested edge and selection state).
 * @returns The icon element.
 */
export function TrackerPanelIcon(props: TrackerPanelIconProps): React.JSX.Element {
  return <IconChecklistOutlineRegular size={props.size} />;
}
