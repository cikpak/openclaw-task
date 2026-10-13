import type { SVGProps } from 'react';
import ArrowRightIcon from '@heroicons/react/24/outline/ArrowRightIcon';
import ArrowUpIcon from '@heroicons/react/24/outline/ArrowUpIcon';
import ArrowLeftIcon from '@heroicons/react/24/outline/ArrowLeftIcon';
import ArrowUpRightIcon from '@heroicons/react/24/outline/ArrowUpRightIcon';
import PlusIcon from '@heroicons/react/24/outline/PlusIcon';
import XMarkIcon from '@heroicons/react/24/outline/XMarkIcon';
import ChevronDownIcon from '@heroicons/react/24/outline/ChevronDownIcon';
import CheckIcon from '@heroicons/react/24/outline/CheckIcon';
import ArrowPathIcon from '@heroicons/react/24/outline/ArrowPathIcon';
import StopIcon from '@heroicons/react/24/outline/StopIcon';
import DocumentTextIcon from '@heroicons/react/24/outline/DocumentTextIcon';
import DocumentPlusIcon from '@heroicons/react/24/outline/DocumentPlusIcon';
import PencilSquareIcon from '@heroicons/react/24/outline/PencilSquareIcon';
import GlobeAltIcon from '@heroicons/react/24/outline/GlobeAltIcon';
import MagnifyingGlassIcon from '@heroicons/react/24/outline/MagnifyingGlassIcon';
import CommandLineIcon from '@heroicons/react/24/outline/CommandLineIcon';
import PhotoIcon from '@heroicons/react/24/outline/PhotoIcon';
import ArrowDownTrayIcon from '@heroicons/react/24/outline/ArrowDownTrayIcon';
import PaperClipIcon from '@heroicons/react/24/outline/PaperClipIcon';
import WrenchScrewdriverIcon from '@heroicons/react/24/outline/WrenchScrewdriverIcon';
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon';
import ArrowRightOnRectangleIcon from '@heroicons/react/24/outline/ArrowRightOnRectangleIcon';
import TrashIcon from '@heroicons/react/24/outline/TrashIcon';

const icons = {
  arrowRight: ArrowRightIcon,
  arrowUp: ArrowUpIcon,
  arrowLeft: ArrowLeftIcon,
  arrowUpRight: ArrowUpRightIcon,
  plus: PlusIcon,
  close: XMarkIcon,
  chevronDown: ChevronDownIcon,
  check: CheckIcon,
  refresh: ArrowPathIcon,
  stop: StopIcon,
  file: DocumentTextIcon,
  write: DocumentPlusIcon,
  edit: PencilSquareIcon,
  globe: GlobeAltIcon,
  search: MagnifyingGlassIcon,
  terminal: CommandLineIcon,
  image: PhotoIcon,
  download: ArrowDownTrayIcon,
  paperclip: PaperClipIcon,
  tool: WrenchScrewdriverIcon,
  settings: Cog6ToothIcon,
  logout: ArrowRightOnRectangleIcon,
  trash: TrashIcon,
  spinner: ArrowPathIcon,
} as const;
export type IconName = keyof typeof icons;
export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  const Glyph = icons[name];
  return (
    <Glyph
      {...props}
      style={{ ...props.style, width: 16, height: 16, flexShrink: 0 }}
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      focusable="false"
    />
  );
}
