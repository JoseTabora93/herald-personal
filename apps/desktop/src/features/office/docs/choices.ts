import type { CalloutKind } from '../../../../shared/office/document.ts'

/* The choices the toolbar and menus offer: fonts, sizes, colours, line spacing and panels. */

export const FONTS = ['Arial', 'Aptos', 'Calibri', 'Cambria', 'Courier New', 'Garamond', 'Georgia', 'Helvetica Neue', 'Times New Roman', 'Trebuchet MS', 'Verdana'] as const

export const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72] as const

export const TEXT_COLORS = [
  '#000000',
  '#434343',
  '#666666',
  '#999999',
  '#b7b7b7',
  '#d9d9d9',
  '#efefef',
  '#ffffff',
  '#c00000',
  '#e8590c',
  '#f08c00',
  '#2f9e44',
  '#0c8599',
  '#1971c2',
  '#3b5bdb',
  '#7048e8',
  '#e03131',
  '#fd7e14',
  '#fab005',
  '#40c057',
  '#15aabf',
  '#228be6',
  '#4c6ef5',
  '#be4bdb'
] as const

export const HIGHLIGHTS = ['#fff27a', '#ffd8a8', '#ffc9c9', '#fcc2d7', '#eebefa', '#d0bfff', '#a5d8ff', '#99e9f2', '#b2f2bb', '#d8f5a2', '#e9ecef', '#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#c0c0c0'] as const

export const LINE_SPACINGS = [
  { value: 1, label: 'Single' },
  { value: 1.15, label: '1.15' },
  { value: 1.5, label: '1.5' },
  { value: 2, label: 'Double' },
  { value: 2.5, label: '2.5' },
  { value: 3, label: 'Triple' }
] as const

export const CALLOUT_LABELS: Record<CalloutKind, string> = {
  info: 'Info panel',
  note: 'Note panel',
  success: 'Success panel',
  warning: 'Warning panel',
  error: 'Error panel'
}
