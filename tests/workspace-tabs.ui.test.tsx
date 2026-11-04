import React from 'react';
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import WorkspaceTabs from '../components/WorkspaceTabs';
afterEach(cleanup);
test('workspace navigation requires consent to discard dirty work', () => {
  const change = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<WorkspaceTabs value="maps" dirty onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: '看板' }));
  expect(change).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '日曆' }));
  expect(change).toHaveBeenCalledWith('calendar');
  confirm.mockRestore();
});
test('saving disables workspace navigation', () => {
  const change = vi.fn();
  render(<WorkspaceTabs value="boards" busy onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: '心智圖' }));
  expect(change).not.toHaveBeenCalled();
});
