import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NodeLaunchScreen } from './NodeLaunchScreen';

describe('NodeLaunchScreen', () => {
  it('exposes a node test action and keeps the result visible', async () => {
    const user = userEvent.setup();
    const onTest = vi.fn();

    const { rerender } = render(
      <NodeLaunchScreen
        endpoint="http://127.0.0.1:7711"
        onEndpointChange={() => {}}
        onTest={onTest}
        onConnect={() => {}}
        onUseDefault={() => {}}
        onContinueOffline={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Test Node' }));
    expect(onTest).toHaveBeenCalledOnce();

    rerender(
      <NodeLaunchScreen
        endpoint="http://127.0.0.1:7711"
        testResult={{
          endpoint: 'http://127.0.0.1:7711',
          status: 'unreachable',
          detail: 'The browser could not read a response.',
        }}
        onEndpointChange={() => {}}
        onTest={onTest}
        onConnect={() => {}}
        onUseDefault={() => {}}
        onContinueOffline={() => {}}
      />,
    );

    expect(screen.getByTestId('node-test-result')).toHaveTextContent('Node test failed');
    expect(screen.getByTestId('node-test-result')).toHaveTextContent('The browser could not read a response.');
  });
});
