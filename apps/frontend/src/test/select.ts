import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

export async function chooseOption(control: HTMLElement, value: string) {
  await userEvent.click(control);
  await act(async () => {});
  const option = screen
    .getAllByRole('option')
    .find((item) => item.getAttribute('data-value') === value);
  if (!option) throw new Error(`Missing select option: ${value}`);
  await userEvent.click(option);
  await act(async () => {});
}
