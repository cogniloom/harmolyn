import React from 'react';
import type { MessageLayout } from '@/types';
import { COLOR_KEYS, THEMES, normalizeColor, presetFor, requestedPalette, resolvePalette, type Appearance, type ColorKey, type ResolvedPalette } from '@/lib/appearance/model';
import { canPersistAppearance, getAppearance, resetTheme, setThemeColor, subscribeAppearance, updateAppearance } from '@/lib/appearance/store';

const COLOR_LABELS: Record<ColorKey, string> = { background: 'Background', surface: 'Panels', accent: 'Accent', text: 'Text' };
const LAYOUTS: { id: MessageLayout; name: string; description: string }[] = [
  { id: 'modern', name: 'Classic', description: 'Aligned messages and avatars' },
  { id: 'bubbles', name: 'Bubbles', description: 'Distinct conversation bubbles' },
  { id: 'terminal', name: 'Compact text', description: 'A minimal, text-first layout' },
];
function paletteStyle(p: ResolvedPalette): React.CSSProperties {
  return { '--preview-bg': p.background, '--preview-panel': p.surface, '--preview-accent': p.accent, '--preview-ink': p.text, '--preview-muted': p.muted, '--preview-border': p.border } as React.CSSProperties;
}
function ThemeThumbnail({ palette }: { palette: ResolvedPalette }) {
  return <span className="theme-thumbnail" style={paletteStyle(palette)} aria-hidden="true">
    <span className="theme-thumbnail-rail"><i /><i /><i /></span>
    <span className="theme-thumbnail-channels"><i /><i /><i /><i /></span>
    <span className="theme-thumbnail-chat"><i /><i /><i /><b /></span>
  </span>;
}
class ColorField extends React.PureComponent<{ colorKey: ColorKey; value: string }, { draft: string; invalid: boolean }> {
  state = { draft: this.props.value, invalid: false };
  componentDidUpdate(previous: Readonly<{ colorKey: ColorKey; value: string }>) {
    if (previous.value !== this.props.value) this.setState({ draft: this.props.value, invalid: false });
  }
  commit = () => {
    const color = normalizeColor(this.state.draft.trim());
    if (!color) { this.setState({ invalid: true }); return; }
    this.setState({ draft: color, invalid: false });
    setThemeColor(this.props.colorKey, color);
  };
  render() {
    const { colorKey, value } = this.props;
    const id = `appearance-color-${colorKey}`;
    return <div className="appearance-color-field">
      <label htmlFor={id}>{COLOR_LABELS[colorKey]}</label>
      <div className="appearance-color-inputs">
        <input className="appearance-color-picker" type="color" value={value} aria-label={`Choose ${COLOR_LABELS[colorKey].toLowerCase()} color`}
          onChange={event => { setThemeColor(colorKey, event.target.value); this.setState({ draft: event.target.value.toUpperCase(), invalid: false }); }} />
        <input id={id} className="appearance-hex" type="text" value={this.state.draft} maxLength={7} autoComplete="off" autoCapitalize="characters" spellCheck={false}
          aria-invalid={this.state.invalid || undefined} aria-describedby={this.state.invalid ? `${id}-error` : undefined}
          onChange={event => this.setState({ draft: event.target.value, invalid: false })} onBlur={this.commit}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') { event.preventDefault(); this.commit(); }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.setState({ draft: value, invalid: false }); }
          }} />
      </div>
      {this.state.invalid && <span id={`${id}-error`} className="appearance-field-error" role="alert">Use six hexadecimal digits, such as #A5B4FC.</span>}
    </div>;
  }
}
interface Props {
  messageLayout?: MessageLayout;
  onSetMessageLayout?: (layout: MessageLayout) => void;
  children?: React.ReactNode;
}
interface State { preferences: Appearance; canPersist: boolean }
/** Pure editor: theme changes touch CSS variables, not the chat/runtime tree. */
export class AppearanceSettings extends React.PureComponent<Props, State> {
  state: State = { preferences: getAppearance(), canPersist: canPersistAppearance() };
  private unsubscribe: (() => void) | undefined;
  componentDidMount() {
    const sync = () => this.setState({ preferences: getAppearance(), canPersist: canPersistAppearance() });
    this.unsubscribe = subscribeAppearance(sync);
    sync();
  }
  componentWillUnmount() { this.unsubscribe?.(); }
  render() {
    const p = this.state.preferences;
    const requested = requestedPalette(p);
    const palette = resolvePalette(requested);
    const selected = presetFor(p.theme);
    const layout = this.props.messageLayout ?? 'modern';
    return <div className="appearance-settings">
      <header className="appearance-heading">
        <div><p className="appearance-eyebrow">Personalization</p><h2>Appearance</h2><p>Choose a theme, then fine-tune its colors. Changes apply immediately.</p></div>
        <span className="appearance-local-badge">Stored on this device</span>
      </header>
      {!this.state.canPersist && <p className="appearance-notice" role="status">Storage is unavailable. Your changes work now but may not survive a restart.</p>}
      <fieldset className="appearance-section">
        <legend>Themes <span className="appearance-count">10</span></legend>
        <p className="appearance-description">Your custom colors are remembered separately for each theme.</p>
        <div className="appearance-theme-grid">
          {THEMES.map(theme => {
            const colors = resolvePalette({ ...theme.colors, ...p.custom[theme.id] });
            return <label className="appearance-theme-option" key={theme.id}>
              <input type="radio" name="harmolyn-theme" value={theme.id} checked={p.theme === theme.id} onChange={() => updateAppearance(value => ({ ...value, theme: theme.id }))} />
              <span className="appearance-theme-card">
                <ThemeThumbnail palette={colors} />
                <span className="appearance-theme-name">{theme.name}<span className="appearance-check" aria-hidden="true">{p.theme === theme.id ? '✓' : ''}</span></span>
                <span className="appearance-theme-description">{theme.description}</span>
              </span>
            </label>;
          })}
        </div>
      </fieldset>
      <section className="appearance-section" aria-labelledby="appearance-colors-heading">
        <div className="appearance-section-title"><h3 id="appearance-colors-heading">Customize {selected.name}</h3><button className="appearance-reset" type="button" onClick={resetTheme} disabled={!p.custom[p.theme]}>Reset colors</button></div>
        <div className="appearance-color-grid">{COLOR_KEYS.map(key => <ColorField key={`${p.theme}-${key}`} colorKey={key} value={requested[key]} />)}</div>
        <p className="appearance-description">Text and accent contrast are adjusted when necessary to keep controls readable.</p>
        {palette.adjusted.length > 0 && <p className="appearance-notice" role="status">Readability adjustment applied to {palette.adjusted.map(key => COLOR_LABELS[key].toLowerCase()).join(', ')}. Your chosen values are still saved.</p>}
      </section>
      <section className="appearance-section" aria-labelledby="appearance-preview-heading">
        <div className="appearance-section-title"><h3 id="appearance-preview-heading">Conversation preview</h3><span className="appearance-description">Sample content</span></div>
        <div className={`appearance-conversation appearance-conversation-${layout}`} style={paletteStyle(palette)} aria-label={`${selected.name} conversation preview`}>
          <div className="appearance-preview-header"><span aria-hidden="true">#</span> general <span className="appearance-preview-encryption">Encrypted conversation</span></div>
          <div className="appearance-preview-messages">
            <div className="appearance-preview-message"><span className="appearance-preview-avatar" aria-hidden="true">A</span><div><strong>Alex <small>10:42</small></strong><p>Everything we need, in one place.</p></div></div>
            <div className="appearance-preview-message"><span className="appearance-preview-avatar appearance-preview-avatar-alt" aria-hidden="true">S</span><div><strong>Sam <small>10:43</small></strong><p>A little more space. A lot more clarity.</p></div></div>
          </div>
          <div className="appearance-preview-composer" aria-hidden="true">Message #general<span>↵</span></div>
        </div>
      </section>
      <fieldset className="appearance-section">
        <legend>Message layout</legend>
        <div className="appearance-layout-grid">{LAYOUTS.map(item => <label className="appearance-segment" key={item.id}>
          <input type="radio" name="harmolyn-message-layout" value={item.id} checked={layout === item.id} disabled={!this.props.onSetMessageLayout} onChange={() => this.props.onSetMessageLayout?.(item.id)} />
          <span><strong>{item.name}</strong><small>{item.description}</small></span>
        </label>)}</div>
        {!this.props.onSetMessageLayout && <p className="appearance-description">Message layout cannot be changed in this view.</p>}
      </fieldset>
      <fieldset className="appearance-section">
        <legend>Navigation density</legend>
        <div className="appearance-density-grid">{(['comfortable', 'compact'] as const).map(density => <label className="appearance-segment" key={density}>
          <input type="radio" name="harmolyn-density" checked={p.density === density} onChange={() => updateAppearance(value => ({ ...value, density }))} />
          <span><strong>{density === 'comfortable' ? 'Comfortable' : 'Compact'}</strong><small>{density === 'comfortable' ? 'More space between items' : 'More navigation items on screen'}</small></span>
        </label>)}</div>
        <p className="appearance-description">Touch controls keep their full target size in either mode.</p>
      </fieldset>
      {this.props.children && <section className="appearance-section appearance-language">{this.props.children}</section>}
    </div>;
  }
}
