import * as XLSX from 'xlsx';
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from './supabase.js';
import { Search, Plus, ChevronRight, ChevronDown, X, FileText, Users, LayoutDashboard, Settings, Building2, Check, AlertCircle, Calendar, MapPin, Phone, Mail, User as UserIcon, Edit3, Filter, Download, Upload, TrendingUp, AlertTriangle, Heart, Pill, BookOpen, ArrowRight, Trash2, Undo2, Redo2, Printer } from 'lucide-react';

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');`;

// Format a Date using its LOCAL date components as YYYY-MM-DD.
// Never use toISOString() for this — it converts to UTC first, which shifts
// the date back by one day in positive-offset timezones (e.g. Bali, UTC+8),
// causing off-by-one bugs in week/day and suspension-range comparisons.
function localIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Shared alphabetical sort used everywhere a class roster is displayed (on-screen and print) so
// a class always reads in name order and a newly enrolled student lands in the right spot
// automatically, rather than always appearing at the bottom of the list.
function compareByName(a, b) {
  return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base', numeric: true });
}

// ============================================================
// CONSTANTS
// ============================================================

// el1/jrk/kg carry no `centre` — both centres have one plain room for each, so they're shown
// everywhere. Canggu splits EL 2 and PK into two named sub-rooms each (its real workbook has
// separate "EL2 Daf"/"EL2 Hib" and "PK Saf"/"PK Lav" sheets); Sanur's real workbook has no such
// split — just one combined "EL 2" sheet and one combined "PK" sheet — so Sanur gets its own
// combined 'el2'/'pk' class ids instead of the Canggu-only split ones. Without this, Sanur's
// sidebar showed all 7 Canggu-style rooms and every EL2/PK import silently piled everyone into
// Daffodil/Saffron while Hibiscus/Lavender sat permanently empty.
const INITIAL_CLASSES = [
  { id: 'el1',  name: 'EL 1',            fullName: 'Early Learners 1',            age: '1–2 yrs',   capacity: 16, dot: '#FBBF24' },
  { id: 'el2d', name: 'EL 2 Daffodil',   fullName: 'Early Learners 2 — Daffodil', age: '2–3 yrs',   capacity: 18, dot: '#FDE68A', centre: 'canggu' },
  { id: 'el2h', name: 'EL 2 Hibiscus',   fullName: 'Early Learners 2 — Hibiscus', age: '2–3 yrs',   capacity: 18, dot: '#FDA4AF', centre: 'canggu' },
  { id: 'el2',  name: 'EL 2',            fullName: 'Early Learners 2',            age: '2–3 yrs',   capacity: 36, dot: '#FDE68A', centre: 'sanur' },
  { id: 'pks',  name: 'PK Saffron',      fullName: 'Pre-Kindergarten Saffron',    age: '3–4 yrs',   capacity: 20, dot: '#FB923C', centre: 'canggu' },
  { id: 'pkl',  name: 'PK Lavender',     fullName: 'Pre-Kindergarten Lavender',   age: '3–4 yrs',   capacity: 20, dot: '#C4B5FD', centre: 'canggu' },
  { id: 'pk',   name: 'PK',              fullName: 'Pre-Kindergarten',            age: '3–4 yrs',   capacity: 40, dot: '#FB923C', centre: 'sanur' },
  { id: 'jrk',  name: 'Jr Kindergarten', fullName: 'Junior Kindergarten',         age: '4–5 yrs',   capacity: 22, dot: '#6EE7B7' },
  { id: 'kg',   name: 'Kindergarten',    fullName: 'Kindergarten',                age: '5–6.5 yrs', capacity: 25, dot: '#7DD3FC' },
];

// Canonical class display order. Supabase has no ordering column, so we keep the
// local `classes` state sorted by this index at every entry point (load, realtime,
// addClass) — this is what every consumer (sidebar, dropdowns, dashboard, filters)
// reads, so the order is consistent and survives a page refresh.
const CLASS_ORDER = INITIAL_CLASSES.map(c => c.id);
function sortClasses(list) {
  return [...list].sort((a, b) => {
    const ai = CLASS_ORDER.indexOf(a.id); const bi = CLASS_ORDER.indexOf(b.id);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

const ClassesContext = React.createContext(null);
function useClasses() { return React.useContext(ClassesContext); }

const CLASS_COLOURS = ['#FBBF24','#FDE68A','#FDA4AF','#FB923C','#C4B5FD','#6EE7B7','#7DD3FC','#F472B6','#A78BFA','#34D399','#FCD34D','#FB7185'];

const PAST_WEEKS = 26; // how many weeks back to show

function buildWeeks() {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const today = new Date();
  const dow = today.getDay();
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() + (dow === 0 ? -6 : 1 - dow));
  thisMonday.setHours(0, 0, 0, 0);
  // Start PAST_WEEKS weeks before current Monday
  const firstMonday = new Date(thisMonday);
  firstMonday.setDate(thisMonday.getDate() - PAST_WEEKS * 7);
  const total = PAST_WEEKS + 1 + 25; // 26 past + current + 25 future = 52
  return Array.from({ length: total }, (_, i) => {
    const mon = new Date(firstMonday);
    mon.setDate(firstMonday.getDate() + i * 7);
    const fri = new Date(mon);
    fri.setDate(mon.getDate() + 4);
    const monIso = localIso(mon);
    const friIso = localIso(fri);
    const label = mon.getMonth() === fri.getMonth()
      ? `${mon.getDate()} – ${fri.getDate()} ${M[mon.getMonth()]} ${mon.getFullYear()}`
      : `${mon.getDate()} ${M[mon.getMonth()]} – ${fri.getDate()} ${M[fri.getMonth()]} ${fri.getFullYear()}`;
    return { id: `w${i + 1}`, label, monDate: monIso, friDate: friIso, current: i === PAST_WEEKS };
  });
}
const WEEKS = buildWeeks();
const TODAY_WEEK_IDX = PAST_WEEKS; // index of the current week in WEEKS

const STATUSES = {
  enrolled:          { label: 'Enrolled',          dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  enrolled_pending:  { label: 'Enrolled — waiting for date', dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  inquiry:           { label: 'Inquiry',           dot: 'bg-slate-400',   chip: 'bg-slate-50 text-slate-700 border-slate-200' },
  quote_sent:        { label: 'Quote sent',        dot: 'bg-amber-500',   chip: 'bg-amber-50 text-amber-800 border-amber-200' },
  invoice_sent:      { label: 'Invoice sent',      dot: 'bg-orange-500',  chip: 'bg-orange-50 text-orange-800 border-orange-200' },
  wait_list:         { label: 'Wait list',         dot: 'bg-violet-500',  chip: 'bg-violet-50 text-violet-800 border-violet-200' },
  placement_fee:     { label: 'Placement fee',     dot: 'bg-pink-500',    chip: 'bg-pink-50 text-pink-800 border-pink-200' },
  suspended:         { label: 'On suspension',     dot: 'bg-blue-500',    chip: 'bg-blue-50 text-blue-800 border-blue-200' },
  extended_holiday:  { label: 'Extended holiday',  dot: 'bg-cyan-500',    chip: 'bg-cyan-50 text-cyan-800 border-cyan-200' },
  left:              { label: 'Left',              dot: 'bg-stone-400',   chip: 'bg-stone-50 text-stone-600 border-stone-200' },
  cancelled:         { label: 'Cancelled',         dot: 'bg-stone-400',   chip: 'bg-stone-50 text-stone-600 border-stone-200' },
};

const INVOICE_STATUSES = {
  not_sent:    { label: '—',          colour: 'text-stone-400' },
  sent:        { label: 'Sent',       colour: 'text-orange-700 bg-orange-50' },
  paid:        { label: 'Paid',       colour: 'text-emerald-800 bg-emerald-50' },
  prepay:      { label: 'Prepay',     colour: 'text-indigo-800 bg-indigo-50' },
};

// Gender dot colours (soft, just a visual hint)
const GENDER = {
  F: { colour: '#F4B8D0', label: 'Girl' },
  M: { colour: '#A8C5DC', label: 'Boy' },
  X: { colour: '#D6D1C4', label: '—' },
};

// ============================================================
// FAKE DATA (everything invented for the demo — no real names)
// ============================================================

const SEED_STUDENTS = [
  // ====== EL 2 Daffodil — ACTIVE ======
  { id: 1, name: 'Wren Beaumont', gender: 'F', centre: 'canggu', classId: 'el2d', status: 'enrolled',
    dob: '2023-04-12', nationality: 'British', parents: 'Alice / Tom', phone: '+62 ••• 4421 (M)\n+62 ••• 4422 (D)', email: 'alice@example.com\ntom@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: 'F', lunch: 'yes',
    note: 'No nuts', dietaryFlags: ['no_nuts'],
    suspensions: [{ start: '2026-01-12', end: '2026-01-16' }],
    originalStart: '2025-08-04', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-07-28', bondAmount: 5000000,
    periodFrom: '2026-05-04', periodUntil: '2026-06-08',
    invoiceStatus: 'sent', invoiceNote: '',
    prepay: null, siblings: [] },

  { id: 2, name: 'Theo Marais', gender: 'M', centre: 'canggu', classId: 'el2d', status: 'enrolled',
    dob: '2023-07-22', nationality: 'French', parents: 'Camille / Luc', phone: '+62 ••• 8819 (M)', email: 'camille@example.com',
    mon: 'F', tue: 'F', wed: '', thu: 'F', fri: 'F', lunch: 'yes',
    note: '', dietaryFlags: [], transitionTo: 'pks', transitionDate: '2026-07-07',
    suspensions: [],
    originalStart: '2025-09-15', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-09-10', bondAmount: 5000000,
    periodFrom: '2026-05-04', periodUntil: '2026-05-29',
    invoiceStatus: 'paid', invoiceNote: '',
    prepay: null, siblings: [] },

  { id: 3, name: 'Indira Soewardjo', gender: 'F', centre: 'canggu', classId: 'el2d', status: 'enrolled',
    dob: '2023-02-08', nationality: 'Indonesian', parents: 'Maya / Budi', phone: '+62 ••• 2210 (M)', email: 'maya@example.com',
    mon: 'H', tue: 'H', wed: 'H', thu: 'H', fri: 'H', lunch: '',
    note: '', dietaryFlags: [],
    suspensions: [{ start: '2026-02-02', end: '2026-02-06' }, { start: '2026-03-23', end: '2026-03-27' }],
    originalStart: '2025-06-02', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-05-28', bondAmount: 5000000,
    periodFrom: '2026-04-13', periodUntil: '2026-06-10',
    invoiceStatus: 'paid', invoiceNote: '',
    prepay: null, siblings: [{ name: 'Rio Soewardjo', class: 'PK Saffron' }] },

  { id: 4, name: 'Olive Kjeldsen', gender: 'F', centre: 'canggu', classId: 'el2d', status: 'enrolled',
    dob: '2023-09-01', nationality: 'Danish', parents: 'Lise / Anders', phone: '+62 ••• 5577 (M)', email: 'lise@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: '', lunch: 'yes',
    note: '', dietaryFlags: [],
    suspensions: [],
    originalStart: '2025-11-03', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-10-28', bondAmount: 5000000,
    periodFrom: '2026-05-04', periodUntil: '2026-06-04',
    invoiceStatus: 'sent', invoiceNote: '',
    prepay: null, siblings: [] },

  { id: 5, name: 'Felix Whittaker', gender: 'M', centre: 'canggu', classId: 'el2d', status: 'suspended',
    dob: '2023-05-18', nationality: 'Australian', parents: 'Sarah / Pete', phone: '+62 ••• 9933 (M)\n+62 ••• 9934 (D)', email: 'sarah@example.com',
    mon: '', tue: '', wed: '', thu: '', fri: '', lunch: '',
    note: 'HS 4–22 May 2026', dietaryFlags: [],
    suspensions: [
      { start: '2025-12-22', end: '2026-01-09' },
      { start: '2026-03-16', end: '2026-03-27' },
      { start: '2026-05-04', end: '2026-05-22' },
    ],
    originalStart: '2025-03-10', returningDate: '2026-05-25', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-03-05', bondAmount: 5000000,
    periodFrom: '2026-04-22', periodUntil: '2026-06-15',
    invoiceStatus: 'paid', invoiceNote: '',
    prepay: null, siblings: [] },

  { id: 6, name: 'Ines Volkov', gender: 'F', centre: 'canggu', classId: 'el2d', status: 'enrolled',
    dob: '2023-08-15', nationality: 'Russian', parents: 'Anya / Mikhail', phone: '+62 ••• 6601 (M)', email: 'anya@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: '', fri: 'F', lunch: 'yes',
    note: '', dietaryFlags: [],
    suspensions: [{ start: '2026-02-10', end: '2026-02-14' }],
    originalStart: '2026-01-20', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2026-01-15', bondAmount: 5000000,
    periodFrom: '2026-05-04', periodUntil: '2026-06-01',
    invoiceStatus: 'sent', invoiceNote: '',
    prepay: null, siblings: [] },

  { id: 7, name: 'Arlo Tanaka-Pierce', gender: 'M', centre: 'canggu', classId: 'el2d', status: 'enrolled',
    dob: '2023-11-30', nationality: 'Japanese / Australian', parents: 'Kana / Greg', phone: '+62 ••• 7745 (M)\n+62 ••• 7746 (D)', email: 'kana@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: 'F', lunch: 'yes',
    note: '', dietaryFlags: [],
    suspensions: [],
    originalStart: '2026-02-09', returningDate: '', lastDate: '', lengthOfStay: '25 weeks',
    bondPaid: '2026-02-05', bondAmount: 5000000,
    periodFrom: '2026-02-09', periodUntil: '2026-08-02',
    invoiceStatus: 'prepay', invoiceNote: 'PAID 25 weeks',
    prepay: { weeks: 25, completed: 14, type: '25w', startDate: '2026-02-09' }, siblings: [] },

  { id: 8, name: 'Mila Halvorsen', gender: 'F', centre: 'canggu', classId: 'el2d', status: 'enrolled',
    dob: '2023-06-04', nationality: 'Norwegian', parents: 'Solveig / Erik', phone: '+62 ••• 1102 (M)', email: 'solveig@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: 'F', lunch: 'yes',
    note: 'No dairy', dietaryFlags: ['no_dairy'],
    suspensions: [],
    originalStart: '2025-10-06', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-10-01', bondAmount: 5000000,
    periodFrom: '2026-05-04', periodUntil: '2026-05-29',
    invoiceStatus: 'paid', invoiceNote: '',
    prepay: null, siblings: [] },

  { id: 9, name: 'Kasper Linden', gender: 'M', centre: 'canggu', classId: 'el2d', status: 'enrolled',
    dob: '2023-03-19', nationality: 'Swedish / Australian', parents: 'Astrid / Jonas', phone: '+62 ••• 3344 (M)', email: 'astrid@example.com',
    mon: 'F', tue: 'F', wed: '', thu: 'F', fri: '', lunch: 'yes',
    note: '', dietaryFlags: [],
    suspensions: [{ start: '2026-01-19', end: '2026-01-30' }],
    originalStart: '2025-07-21', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-07-15', bondAmount: 5000000,
    periodFrom: '2026-04-20', periodUntil: '2026-05-22',
    invoiceStatus: 'sent', invoiceNote: '',
    prepay: null, siblings: [] },

  { id: 10, name: 'Juno Castellano', gender: 'F', centre: 'canggu', classId: 'el2d', status: 'enrolled',
    dob: '2023-10-09', nationality: 'Italian', parents: 'Giulia / Marco', phone: '+62 ••• 5500 (M)\n+62 ••• 5501 (D)', email: 'giulia@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: 'F', lunch: 'yes',
    note: '', dietaryFlags: [],
    suspensions: [],
    originalStart: '2025-12-08', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-12-04', bondAmount: 5000000,
    periodFrom: '2026-05-04', periodUntil: '2026-06-30',
    invoiceStatus: 'paid', invoiceNote: '',
    prepay: null, siblings: [] },

  // ====== EL 2 Daffodil — WAITLIST ======
  { id: 11, name: 'Saskia Levin', gender: 'F', centre: 'canggu', classId: 'el2d', status: 'invoice_sent',
    dob: '2023-03-25', nationality: 'German', parents: 'Hannah / Ben', phone: '+62 ••• 4470 (M)', email: 'hannah@example.com',
    mon: '', tue: '', wed: '', thu: '', fri: '', lunch: '',
    note: 'Invoice sent 16 May — awaiting confirmation', dietaryFlags: [],
    suspensions: [],
    originalStart: '2026-06-01', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '', bondAmount: 0,
    periodFrom: '', periodUntil: '',
    invoiceStatus: 'sent', invoiceNote: 'Invoice sent 16 May',
    prepay: null, siblings: [] },

  { id: 12, name: 'Mira Halvorsen', gender: 'F', centre: 'canggu', classId: 'el2d', status: 'quote_sent',
    dob: '2023-06-04', nationality: 'Norwegian', parents: 'Solveig / Erik', phone: '+62 ••• 1102 (M)', email: 'solveig@example.com',
    mon: '', tue: '', wed: '', thu: '', fri: '', lunch: '',
    note: 'Sister of Mila — twin enrolment', dietaryFlags: [],
    suspensions: [],
    originalStart: 'tbc', returningDate: '', lastDate: '', lengthOfStay: 'tbc',
    bondPaid: '', bondAmount: 0,
    periodFrom: '', periodUntil: '',
    invoiceStatus: 'not_sent', invoiceNote: '',
    prepay: null, siblings: [{ name: 'Mila Halvorsen', class: 'EL 2 Daffodil' }] },

  { id: 13, name: 'Bodhi Almeida', gender: 'M', centre: 'canggu', classId: 'el2d', status: 'wait_list',
    dob: '2023-10-19', nationality: 'Portuguese', parents: 'Joana / Diogo', phone: '+62 ••• 3388 (M)', email: 'joana@example.com',
    mon: '', tue: '', wed: '', thu: '', fri: '', lunch: '',
    note: 'Returning to Bali July', dietaryFlags: [],
    suspensions: [],
    originalStart: '2026-07-13', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '', bondAmount: 0,
    periodFrom: '', periodUntil: '',
    invoiceStatus: 'not_sent', invoiceNote: '',
    prepay: null, siblings: [] },

  // ====== EL 2 Daffodil — RECENTLY LEFT ======
  { id: 14, name: 'Atlas Reyes', gender: 'M', centre: 'canggu', classId: 'el2d', status: 'left',
    dob: '2023-01-14', nationality: 'Mexican / Australian', parents: 'Paloma / Diego', phone: '+62 ••• 8800 (M)', email: 'paloma@example.com',
    mon: '', tue: '', wed: '', thu: '', fri: '', lunch: '',
    note: 'Family moved back to Sydney', dietaryFlags: [],
    suspensions: [],
    originalStart: '2025-06-30', returningDate: '', lastDate: '2026-04-25', lengthOfStay: 'Long term',
    bondPaid: '2025-06-25', bondAmount: 5000000,
    periodFrom: '2026-03-30', periodUntil: '2026-04-25',
    invoiceStatus: 'paid', invoiceNote: 'Final invoice settled',
    prepay: null, siblings: [] },

  { id: 15, name: 'Calla Donnelly', gender: 'F', centre: 'canggu', classId: 'el2d', status: 'left',
    dob: '2022-11-21', nationality: 'Irish', parents: 'Niamh / Sean', phone: '+62 ••• 4422 (M)', email: 'niamh@example.com',
    mon: '', tue: '', wed: '', thu: '', fri: '', lunch: '',
    note: 'Transitioned to PK Saffron 4 weeks early due to age', dietaryFlags: [],
    suspensions: [],
    originalStart: '2025-08-04', returningDate: '', lastDate: '2026-04-04', lengthOfStay: 'Long term',
    bondPaid: '2025-07-30', bondAmount: 5000000,
    periodFrom: '', periodUntil: '',
    invoiceStatus: 'paid', invoiceNote: 'Bond transferred to PK Saffron',
    prepay: null, siblings: [] },

  // ====== Other classes (for sidebar counts) ======
  { id: 21, name: 'Juno Pearce', gender: 'F', centre: 'canggu', classId: 'el1', status: 'enrolled',
    dob: '2024-08-11', nationality: 'British', parents: 'Emma / Will', phone: '+62 ••• 1001 (M)', email: 'emma@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: '', fri: '', lunch: 'yes',
    note: '', dietaryFlags: [], suspensions: [],
    originalStart: '2025-12-01', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-11-28', bondAmount: 5000000, periodFrom: '2026-05-04', periodUntil: '2026-06-01',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [] },
  { id: 22, name: 'Otis Brennan', gender: 'M', centre: 'canggu', classId: 'el1', status: 'enrolled',
    dob: '2024-10-02', nationality: 'Australian', parents: 'Lily / Sam', phone: '+62 ••• 1002 (M)', email: 'lily@example.com',
    mon: 'F', tue: 'F', wed: '', thu: 'F', fri: 'F', lunch: 'yes',
    note: '', dietaryFlags: [], suspensions: [],
    originalStart: '2026-01-08', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2026-01-04', bondAmount: 5000000, periodFrom: '2026-05-04', periodUntil: '2026-06-01',
    invoiceStatus: 'sent', invoiceNote: '', prepay: null, siblings: [] },
  { id: 31, name: 'Esme Linwood', gender: 'F', centre: 'canggu', classId: 'el2h', status: 'enrolled',
    dob: '2023-05-30', nationality: 'British', parents: 'Cleo / Jack', phone: '+62 ••• 1101 (M)', email: 'cleo@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: 'F', lunch: 'yes',
    note: '', dietaryFlags: [], suspensions: [{ start: '2026-01-12', end: '2026-01-16' }],
    originalStart: '2025-09-01', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-08-25', bondAmount: 5000000, periodFrom: '2026-05-04', periodUntil: '2026-06-01',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [] },
  { id: 41, name: 'Rio Soewardjo', gender: 'M', centre: 'canggu', classId: 'pks', status: 'enrolled',
    dob: '2022-04-18', nationality: 'Indonesian', parents: 'Maya / Budi', phone: '+62 ••• 2210 (M)', email: 'maya@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: '', lunch: 'yes',
    note: 'Brother of Indira (EL2 Daffodil)', dietaryFlags: [], suspensions: [],
    originalStart: '2025-08-04', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-07-30', bondAmount: 5000000, periodFrom: '2026-05-04', periodUntil: '2026-06-01',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [{ name: 'Indira Soewardjo', class: 'EL 2 Daffodil' }] },
  { id: 51, name: 'Cleo Marchetti', gender: 'F', centre: 'canggu', classId: 'pkl', status: 'enrolled',
    dob: '2022-09-09', nationality: 'Italian', parents: 'Sofia / Marco', phone: '+62 ••• 3301 (M)', email: 'sofia@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: 'F', lunch: 'yes',
    note: '', dietaryFlags: [], suspensions: [],
    originalStart: '2025-08-04', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-07-30', bondAmount: 5000000, periodFrom: '2026-05-04', periodUntil: '2026-06-01',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [] },
  { id: 61, name: 'Nico Albright', gender: 'M', centre: 'canggu', classId: 'jrk', status: 'enrolled',
    dob: '2021-11-22', nationality: 'American', parents: 'Hope / Dan', phone: '+62 ••• 4401 (M)', email: 'hope@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: 'F', lunch: 'yes',
    note: 'Has speech delay (following CCS Calendar)', dietaryFlags: [], hasMedicalFlag: true,
    suspensions: [{ start: '2026-01-20', end: '2026-02-03' }, { start: '2026-03-23', end: '2026-04-04' }],
    originalStart: '2024-09-01', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2024-08-25', bondAmount: 5000000, periodFrom: '2026-05-04', periodUntil: '2026-06-01',
    invoiceStatus: 'prepay', invoiceNote: 'PAID 37 weeks', prepay: { weeks: 37, completed: 32, type: '37w', startDate: '2025-09-29' }, siblings: [] },
  { id: 71, name: 'Petra Vanek', gender: 'F', centre: 'canggu', classId: 'kg', status: 'enrolled',
    dob: '2020-06-15', nationality: 'Czech', parents: 'Lucie', phone: '+62 ••• 5501 (M)', email: 'lucie@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: 'F', lunch: 'yes',
    note: 'LAST DAY 15 JUNE 2026 — moving to school', dietaryFlags: [], hasLastDayFlag: true,
    suspensions: [{ start: '2025-12-22', end: '2026-01-18' }, { start: '2026-03-23', end: '2026-04-04' }, { start: '2026-04-15', end: '2026-04-22' }],
    originalStart: '2024-01-15', returningDate: '', lastDate: '2026-06-15', lengthOfStay: 'Long term',
    bondPaid: '2024-01-10', bondAmount: 5000000, periodFrom: '2026-04-22', periodUntil: '2026-05-25',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [] },
  { id: 72, name: 'Lev Karpov', gender: 'M', centre: 'canggu', classId: 'kg', status: 'enrolled',
    dob: '2020-09-30', nationality: 'Russian', parents: 'Tatiana / Yuri', phone: '+62 ••• 5502 (M)', email: 'tatiana@example.com',
    mon: 'F', tue: '', wed: 'F', thu: '', fri: 'F', lunch: 'yes',
    note: '', dietaryFlags: [], suspensions: [],
    originalStart: '2024-08-04', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2024-08-01', bondAmount: 5000000, periodFrom: '2026-05-04', periodUntil: '2026-06-01',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [] },

  // Sanur
  { id: 101, name: 'Mae Christensen', gender: 'F', centre: 'sanur', classId: 'el2d', status: 'enrolled',
    dob: '2023-07-04', nationality: 'Danish', parents: 'Frida / Lars', phone: '+62 ••• 9911 (M)', email: 'frida@example.com',
    mon: 'F', tue: 'F', wed: 'F', thu: 'F', fri: 'F', lunch: 'yes',
    note: '', dietaryFlags: [], suspensions: [],
    originalStart: '2025-11-10', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-11-05', bondAmount: 5000000, periodFrom: '2026-05-04', periodUntil: '2026-06-01',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [] },
  { id: 102, name: 'Kai Sutopo', gender: 'M', centre: 'sanur', classId: 'pks', status: 'enrolled',
    dob: '2022-12-01', nationality: 'Indonesian / Australian', parents: 'Wati / James', phone: '+62 ••• 9912 (M)', email: 'wati@example.com',
    mon: 'F', tue: 'F', wed: '', thu: 'F', fri: 'F', lunch: 'yes',
    note: '', dietaryFlags: [], suspensions: [],
    originalStart: '2025-09-15', returningDate: '', lastDate: '', lengthOfStay: 'Long term',
    bondPaid: '2025-09-10', bondAmount: 5000000, periodFrom: '2026-05-04', periodUntil: '2026-06-01',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [] },

  // ====== Pre-archived students (from earlier years) ======
  { id: 201, name: 'Indigo Faulkner', gender: 'M', centre: 'canggu', classId: 'kg', status: 'left',
    dob: '2018-03-15', nationality: 'British', parents: 'Tessa / Rohan', phone: '+62 ••• 4421 (M)', email: 'tessa@example.com',
    mon: '', tue: '', wed: '', thu: '', fri: '', lunch: '',
    note: 'Aged out — moved to primary school in Singapore', dietaryFlags: [], suspensions: [],
    originalStart: '2021-01-20', returningDate: '', lastDate: '2024-12-15', lengthOfStay: 'Long term',
    bondPaid: '2021-01-15', bondAmount: 5000000, periodFrom: '', periodUntil: '',
    invoiceStatus: 'paid', invoiceNote: 'Final invoice settled', prepay: null, siblings: [],
    archived: true, archivedAt: '2024-12-20' },
  { id: 202, name: 'Mei Yamamoto', gender: 'F', centre: 'canggu', classId: 'jrk', status: 'left',
    dob: '2019-07-08', nationality: 'Japanese', parents: 'Saki / Hiro', phone: '+81 90 ••• 4422', email: 'saki@example.com',
    mon: '', tue: '', wed: '', thu: '', fri: '', lunch: '',
    note: 'Family moved back to Tokyo', dietaryFlags: ['no_dairy'], suspensions: [],
    originalStart: '2022-08-01', returningDate: '', lastDate: '2024-06-30', lengthOfStay: 'Long term',
    bondPaid: '2022-07-25', bondAmount: 5000000, periodFrom: '', periodUntil: '',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [],
    archived: true, archivedAt: '2024-07-05' },
  { id: 203, name: 'Lucca Romano', gender: 'M', centre: 'canggu', classId: 'pks', status: 'left',
    dob: '2020-11-22', nationality: 'Italian', parents: 'Elena / Pietro', phone: '+62 ••• 5533 (M)', email: 'elena@example.com',
    mon: '', tue: '', wed: '', thu: '', fri: '', lunch: '',
    note: 'Returning family — possible re-enrolment 2026/2027', dietaryFlags: [], suspensions: [],
    originalStart: '2023-02-10', returningDate: '', lastDate: '2024-11-30', lengthOfStay: 'Long term',
    bondPaid: '2023-02-05', bondAmount: 5000000, periodFrom: '', periodUntil: '',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [],
    archived: true, archivedAt: '2024-12-05' },
  { id: 204, name: 'Zara Achterberg', gender: 'F', centre: 'canggu', classId: 'el2h', status: 'left',
    dob: '2021-04-30', nationality: 'Dutch', parents: 'Anouk / Bram', phone: '+31 6 ••• 7788', email: 'anouk@example.com',
    mon: '', tue: '', wed: '', thu: '', fri: '', lunch: '',
    note: 'Sister of new inquiry Noa Lindgren — verify if related family', dietaryFlags: [], suspensions: [],
    originalStart: '2023-09-04', returningDate: '', lastDate: '2025-07-25', lengthOfStay: 'Long term',
    bondPaid: '2023-08-30', bondAmount: 5000000, periodFrom: '', periodUntil: '',
    invoiceStatus: 'paid', invoiceNote: '', prepay: null, siblings: [],
    archived: true, archivedAt: '2025-08-01' },
];

const EXAMPLE_EMAIL = `Sent via form submission from The Garden Bali

Name (Person completing this form): Sophia Lindgren
Date of arrival to Bali: 12-06-2026
How long do you intend to stay in Bali?: 18 months
What classes are you interested in?: EL 2 (2-3 years)
Which days are you looking to enrol?: Monday, Tuesday, Thursday
Half Day or Full Day?: Full Day (8am - 3pm)
Preferred Start Date: 20-07-2026
Childs Full Name: noa lindgren
Nationality: Swedish
Date of Birth: March 14, 2024
Gender: Female
Native Language: Swedish and English
Parent 1 Contact: Sophia Lindgren
Parent 1 Email: sophia.l@example.com
Parent 1 Occupation: Designer
Parent 1 Phone Number: +46 70 ••• 4421
Parent 2 Contact: Mattias Lindgren
Parent 2 Email: mattias.l@example.com
Parent 2 Occupation: Architect
Parent 2 Phone Number: +46 70 ••• 4422
Has your child had all of their age appropriate vaccinations?: Yes
If yes, please supply us with more details.: DTP, Hep A, MMR, Meningitis
Does your child have any medical disabilities or special educational needs?: No
Does your child have any medical problems or allergies?: No
Are there any food allergies that your child has? *: Yes
If yes, please supply us with more details.: Mild dairy intolerance
Does your child require an Epipen?: No
Is there anything else you would like us to know about your child?: Loves music and dancing.`;

// ============================================================
// HELPERS
// ============================================================

// Best-effort conversion of a free-text date (as typed by a parent on the enrolment form, or
// typed manually by staff) into the ISO yyyy-mm-dd format the date picker and age calculation
// require. Falls back to returning the input unchanged if no known pattern matches.
function normalizeDobToIso(v) {
  if (!v) return v;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (parseInt(y) < 50 ? '20' : '19') + y;
    if (parseInt(mo) <= 12 && parseInt(d) <= 31) return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[2].slice(0, 3).toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[1].slice(0, 3).toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return s;
}

function ageFromDob(dob) {
  if (!dob || dob === 'tbc') return '–';
  let d = new Date(dob);
  if (isNaN(d)) d = new Date(normalizeDobToIso(dob));
  if (isNaN(d)) return '–';
  const now = new Date();
  let y = now.getFullYear() - d.getFullYear();
  let m = now.getMonth() - d.getMonth();
  if (now.getDate() < d.getDate()) m--;
  if (m < 0) { y--; m += 12; }
  return `${y}Y ${m}M`;
}

function isoAddDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localIso(d);
}

// Parse free-text holiday suspension notes into structured date ranges.
// Returns { ranges: [{start,end}], remainingNote: string } or null if nothing found.
function parseHolidaySuspensionNote(note) {
  if (!note) return null;
  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
    january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
  const MP = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

  const parseYear = (yr) => {
    if (!yr) return new Date().getFullYear();
    const n = parseInt(yr);
    return n < 100 ? 2000 + n : n; // "25" → 2025, "2025" → 2025
  };
  const toIso = (day, mon, year) => {
    const mNum = MONTHS[mon.toLowerCase()];
    if (!mNum) return null;
    const maxDay = new Date(year, mNum, 0).getDate(); // last valid day of this month
    const d = Math.min(Math.max(parseInt(day), 1), maxDay); // clamp so we never emit e.g. 31 Jun
    return `${year}-${String(mNum).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  };
  const lastDayIso = (mon, year) => {
    const mNum = MONTHS[mon.toLowerCase()];
    if (!mNum) return null;
    const last = new Date(year, mNum, 0).getDate(); // day 0 of next month = last day of this month
    return `${year}-${String(mNum).padStart(2,'0')}-${String(last).padStart(2,'0')}`;
  };

  // Track which character positions are already claimed to prevent double-matching
  const claimedRanges = []; // [{from, to}] index ranges in note
  const isClaimed = (matchIndex, matchLen) => claimedRanges.some(r => matchIndex < r.to && matchIndex + matchLen > r.from);
  const claim = (matchIndex, matchLen) => claimedRanges.push({ from: matchIndex, to: matchIndex + matchLen });

  const ranges = [];

  // ── Pattern A: cross-month ranges with optional year on EITHER end
  // Handles: "8 Feb - 1 Mar 2026", "10 Dec 25 - 4 Jan 2026", "13 Mar – 3 Apr"
  const PA = new RegExp(`(\\d{1,2})\\s+(${MP})(?:\\s+(\\d{2,4}))?\\s*[-–—]\\s*(\\d{1,2})\\s+(${MP})(?:\\s+(\\d{2,4}))?`, 'gi');
  let m;
  PA.lastIndex = 0;
  while ((m = PA.exec(note)) !== null) {
    if (isClaimed(m.index, m[0].length)) continue;
    const [full, d1, mon1, yr1Raw, d2, mon2, yr2Raw] = m;
    const curYear = new Date().getFullYear();
    const m1n = MONTHS[mon1.toLowerCase()], m2n = MONTHS[mon2.toLowerCase()];
    let y1, y2;
    if (yr2Raw) {
      y2 = parseYear(yr2Raw);
      y1 = yr1Raw ? parseYear(yr1Raw) : (m1n && m2n && m1n > m2n ? y2 - 1 : y2);
    } else if (yr1Raw) {
      y1 = parseYear(yr1Raw);
      y2 = (m1n && m2n && m2n < m1n) ? y1 + 1 : y1;
    } else {
      y1 = y2 = curYear;
      if (m1n && m2n && m1n > m2n) y1 = y2 - 1;
    }
    const start = toIso(d1, mon1, y1);
    const end   = toIso(d2, mon2, y2);
    if (start && end && end >= start) { ranges.push({ start, end, _match: full, _idx: m.index }); claim(m.index, full.length); }
  }

  // ── Pattern B: "24 Nov 25 - Jan 2026" or "18 May - August"  (day+month+[year] – month+[year], NO end day)
  // End defaults to last day of the end month. The end year is optional (open-ended notes like
  // "18 May - August" are common) — when omitted, infer the same year as the start, unless the
  // end month numerically precedes the start month, which means the range wraps into next year
  // (e.g. "20 Dec - Feb" runs Dec this year through Feb the following year).
  const PB = new RegExp(`(\\d{1,2})\\s+(${MP})(?:\\s+(\\d{2,4}))?\\s*[-–—]\\s*(${MP})(?:\\s+(\\d{2,4}))?`, 'gi');
  PB.lastIndex = 0;
  while ((m = PB.exec(note)) !== null) {
    if (isClaimed(m.index, m[0].length)) continue;
    const [full, d1, mon1, yr1Raw, mon2, yr2Raw] = m;
    const m1n = MONTHS[mon1.toLowerCase()], m2n = MONTHS[mon2.toLowerCase()];
    const curYear = new Date().getFullYear();
    let y1, y2;
    if (yr1Raw) {
      y1 = parseYear(yr1Raw);
      y2 = yr2Raw ? parseYear(yr2Raw) : (m1n && m2n && m2n < m1n ? y1 + 1 : y1);
    } else if (yr2Raw) {
      y2 = parseYear(yr2Raw);
      y1 = (m1n && m2n && m1n > m2n) ? y2 - 1 : y2;
    } else {
      y1 = curYear;
      y2 = (m1n && m2n && m2n < m1n) ? y1 + 1 : y1;
    }
    const start = toIso(d1, mon1, y1);
    const end   = lastDayIso(mon2, y2); // no day given → last day of end month
    if (start && end && end >= start) { ranges.push({ start, end, _match: full, _idx: m.index }); claim(m.index, full.length); }
  }

  // ── Pattern C: "14 - 18 July 2025"  (day – day month [year], same month)
  const PC = new RegExp(`(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})\\s+(${MP})(?:\\s+(\\d{2,4}))?`, 'gi');
  PC.lastIndex = 0;
  while ((m = PC.exec(note)) !== null) {
    if (isClaimed(m.index, m[0].length)) continue;
    const [full, d1, d2, mon, yrRaw] = m;
    const year = parseYear(yrRaw);
    const start = toIso(d1, mon, year);
    const end   = toIso(d2, mon, year);
    if (start && end && end >= start) { ranges.push({ start, end, _match: full, _idx: m.index }); claim(m.index, full.length); }
  }

  if (ranges.length === 0) return null;

  // Sort by start date for clean display
  ranges.sort((a, b) => a.start.localeCompare(b.start));

  // Remove parsed sections + common HS prefixes from the note
  const prefixRex = /\b(Holiday\s*Suspension\s*:?\s*|HS\s*(?:From\s*|[0-9]+\.\s*)?)/gi;
  let cleaned = note;
  for (const r of ranges) { if (r._match) cleaned = cleaned.replace(r._match, ''); }
  cleaned = cleaned.replace(prefixRex, '').replace(/\s*[,;]\s*/g, ' ').replace(/\s*\d+\.\s*/g, ' ').trim();

  return {
    ranges: ranges.map(({ start, end }) => ({ start, end })),
    remainingNote: cleaned,
  };
}

// Run note migration on a student array. Returns { students, migrationLog }
// Also deduplicates existing suspension chips on every student (not just those with HS in notes).
//
// Suspensions parsed out of an imported note are tagged `fromImport: true`. Whenever this
// function runs against a student whose note *currently* contains fresh HS text (i.e. right
// after a spreadsheet import re-populates the note — see the `Holiday Suspension:` append in
// parseSpreadsheetFile), it REPLACES that student's fromImport-tagged entries with the new
// parse rather than appending to them. This makes repeated imports idempotent/self-correcting
// instead of silently accumulating stale or duplicate date ranges over time — that accumulation
// was the root cause of students showing extra/wrong-year suspension entries that no longer
// matched the source spreadsheet.
//
// Note that the note field is *always* stripped of HS text once parsed, by design — so on every
// routine app load (not a fresh import) `shouldParse` will be false for already-migrated
// students. That's expected and must NOT be treated as "the suspension no longer applies";
// only an actual re-parse (fresh HS text present) should ever replace fromImport entries.
// Suspensions without the tag are assumed to be added by hand via the app UI and are always
// preserved untouched.
function migrateHolidaySuspensionNotes(students) {
  const migrationLog = [];
  const updated = students.map(s => {
    const note = s.note || '';
    const rawSusp = s.suspensions || [];

    // ── Step 1: split into manually-added (untagged) vs previously-imported (tagged) chips ──
    const manual = rawSusp.filter(x => !x.fromImport);
    const dedupedManual = manual.filter((item, idx, arr) =>
      idx === arr.findIndex(x => x.start === item.start && x.end === item.end)
    );
    const priorImport = rawSusp.filter(x => x.fromImport);
    const dedupedPriorImport = priorImport.filter((item, idx, arr) =>
      idx === arr.findIndex(x => x.start === item.start && x.end === item.end)
    );
    const baseline = [...dedupedManual, ...dedupedPriorImport];
    const dedupChanged = baseline.length !== rawSusp.length;

    // ── Step 2: parse note if it contains HS text OR a leftover date-range pattern ──
    // Broadened trigger catches partial migrations (note cleaned of HS keywords but
    // still has a leftover "10 Dec 25 - 4 Jan 2026" that wasn't parsed first time).
    const hasHsKeyword = /holiday\s*sus|(?:^|\s)hs\s/i.test(note);
    // Also catches leftover date-range text after partial migrations (e.g. "10 Dec 25 - 4 Jan 2026")
    const hasDateRange = /\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*(?:\s+\d{2,4})?\s*[-–—]/i.test(note);
    const shouldParse = hasHsKeyword || hasDateRange;

    if (!shouldParse) {
      // Nothing fresh to reconcile against — leave existing suspensions (manual + prior
      // import) exactly as they are; only apply dedup if that changed anything.
      return dedupChanged ? { ...s, suspensions: baseline } : s;
    }

    const result = parseHolidaySuspensionNote(note);
    if (!result) {
      migrationLog.push({ name: s.name, note, status: 'unparsed' });
      return dedupChanged ? { ...s, suspensions: baseline } : s;
    }

    // Fresh parse of the current note, deduplicated against itself and against manual chips —
    // this REPLACES dedupedPriorImport rather than appending to it.
    const freshImport = result.ranges
      .filter((nr, idx, arr) => arr.findIndex(x => x.start === nr.start && x.end === nr.end) === idx)
      .filter(nr => !dedupedManual.some(e => e.start === nr.start && e.end === nr.end))
      .map(r => ({ ...r, fromImport: true }));

    migrationLog.push({ name: s.name, note, status: 'migrated', ranges: freshImport, remaining: result.remainingNote });
    return { ...s, suspensions: [...dedupedManual, ...freshImport], note: result.remainingNote };
  });
  return { students: updated, migrationLog };
}

// Explicit, named allowlist — NOT a general rule. The user identified these students by name
// (first the Sanur 7 from their Excel occupancy sheet, later an 18-name Canggu batch) and was
// explicit that both (a) forcing S on every day of an active suspension regardless of known
// values, and (b) auto-blanking the weekly pattern once the suspension ends, must apply ONLY to
// these named children, never to any other student now or in future. Do not generalize this into
// a rule keyed on "has a suspension" — that was tried and explicitly rejected.
const AUTO_BLANK_ON_SUSPENSION_END_NAMES = [
  // Sanur
  'Linn Grietje Voerman', 'Riley Catalina Manguino', 'Bernat Batara Sandor',
  'Carter Hendricks Manguino', 'Kai Donoso Ave', 'Noor Elisanne Voerman', 'Bayu Haven Wynn',
  // Canggu
  'Isabella Yong', 'Poppy Meyer', 'Maya Landau', 'Massimo Golian', 'Astrid Clare Oak',
  'Aurora te ao mārama Harris', 'Nina Revita Fiacco', 'Austin Frederick  Arthur Rabbidge',
  'Kohaku Kanazawa', 'Vienna Valloe', 'Elio Holm', 'Kyla Ocean Hoehn', 'Jesse Vooderwind',
  'Remi Martin', 'Dean (Dino) Ikhlas Paul De Mol', 'Elsie Clark', 'Sofia Dixon', 'Harvey Drury',
];

// Once a Holiday Suspension's end date has passed, the child's weekly F/H pattern is wiped
// to blank so staff re-enter it fresh rather than the old pre-suspension pattern silently
// carrying on. Each suspension entry gets a `daysCleared` flag so this only ever fires once
// per suspension. Only applies to AUTO_BLANK_ON_SUSPENSION_END_NAMES (see above) — everyone
// else's suspensions are left completely untouched by this function.
function clearExpiredSuspensionDays(students, todayIso) {
  const cleared = [];
  const updated = students.map(s => {
    if (!AUTO_BLANK_ON_SUSPENSION_END_NAMES.includes(s.name)) return s;
    const susp = s.suspensions || [];
    if (susp.length === 0) return s;
    let daysWiped = false;
    const nextSusp = susp.map(entry => {
      if (entry.end >= todayIso) return entry; // still active or in the future — leave alone
      if (entry.daysCleared) return entry; // already handled
      if (entry.daysCleared === undefined) return { ...entry, daysCleared: true }; // grandfather, no wipe
      daysWiped = true;
      return { ...entry, daysCleared: true };
    });
    const suspChanged = nextSusp.some((e, i) => e !== susp[i]);
    if (!suspChanged) return s;
    const next = daysWiped
      ? { ...s, suspensions: nextSusp, mon: '', tue: '', wed: '', thu: '', fri: '' }
      : { ...s, suspensions: nextSusp };
    if (daysWiped) cleared.push(s.name);
    return next;
  });
  return { students: updated, cleared };
}

// A student marked "Enrolled — waiting for date" has already paid/secured a spot but hasn't
// started yet, so they stay in the Waitlist/Pipeline section (green) until their start date
// arrives. Once that date passes, they need to actually become 'enrolled' and move into the
// active class list — this sweep does that automatically on load rather than relying on staff
// to remember to flip the status by hand.
function promoteEnrolledPendingStudents(students, todayIso) {
  const promoted = [];
  const updated = students.map(s => {
    if (s.status !== 'enrolled_pending') return s;
    if (!isIsoDate(s.originalStart) || s.originalStart > todayIso) return s;
    promoted.push(s.name);
    return { ...s, status: 'enrolled' };
  });
  return { students: updated, promoted };
}

// Guards against free-text values landing in date fields (e.g. an imported "Started" or
// "Last Date" cell reading "Monday 18th", "tbc", "ASAP", "–") being compared as if they were
// real ISO dates. String comparison on non-ISO text is unpredictable — e.g. "Monday 18th" >
// any "YYYY-MM-DD" string — and can silently exclude a student from date-filtered views (they
// just vanish, even though their record is untouched). Every comparison against originalStart/
// lastDate/transitionDate across the app should go through this guard first.
function isIsoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// Shared active-student predicate used by sidebar, class header, and dashboard.
// A student counts as active if their Last Day is unset OR is today or later.
function isStudentActive(s) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return !isIsoDate(s.lastDate) || s.lastDate >= today;
}

// A "schedule change" ({ effectiveDate, mon, tue, wed, thu, fri }) lets staff set a child's
// future weekly pattern (e.g. "add Wednesday from 27 Jul") from the student panel without
// touching what past/current weeks already show — the base mon/tue/wed/thu/fri fields on the
// student stay exactly as they are for any date before the change kicks in. Returns whichever
// schedule change is most recently effective on or before the given date, or null if none apply
// yet (meaning the base pattern is still in force).
function scheduleChangeForDate(student, dateIso) {
  const changes = student.scheduleChanges || [];
  let best = null;
  for (const c of changes) {
    if (c.effectiveDate && c.effectiveDate <= dateIso && (!best || c.effectiveDate > best.effectiveDate)) best = c;
  }
  return best;
}

function dayValueForDate(student, day, dateIso) {
  if (!dateIso) return student[day] || '';
  const change = scheduleChangeForDate(student, dateIso);
  return change ? (change[day] || '') : (student[day] || '');
}

function shortDate(d) {
  if (!d || d === 'tbc') return d || '–';
  let dt = new Date(d);
  if (isNaN(dt)) dt = new Date(normalizeDobToIso(d));
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}

// Renders the structured suspensions list (the source of truth, edited from the student's
// "Holiday suspensions" panel) into the same free-text summary shown in the main class table's
// "Holiday Suspension" column, so that column always reflects what was actually added instead of
// staying blank/stale after an edit made only through the structured panel.
function formatSuspensionsNote(ranges) {
  return ranges.map((r, i) => `${i + 1}. ${shortDate(r.start)} - ${shortDate(r.end)}`).join('\n');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Lunch / Social media are three-state fields: '' (blank/not set), 'yes' (black tick), 'no' (red
// cross) — needed because those fields aren't simple yes/no toggles in the real roster; staff
// need to explicitly mark "no" (e.g. a parent declined social media use) distinctly from "not yet
// asked/blank", which a plain boolean can't represent.
function cycleTriState(v) {
  return v === 'yes' ? 'no' : v === 'no' ? '' : 'yes';
}

function TriStateBox({ value, onClick, className = 'w-5 h-5', iconSize = 12 }) {
  return (
    <button
      onClick={onClick}
      className={`${className} rounded border flex items-center justify-center ${value === 'yes' ? 'bg-stone-900 border-stone-900' : value === 'no' ? 'bg-red-600 border-red-600' : 'bg-white border-stone-300'}`}>
      {value === 'yes' && <Check size={iconSize} className="text-white" />}
      {value === 'no' && <X size={iconSize} className="text-white" />}
    </button>
  );
}

// Dietary flag: a simple two-state box (blank / solid red), no icon — meant to be an
// unmissable at-a-glance "this child has a dietary restriction" marker for staff, separate
// from the detailed dietaryFlags list which records what the restriction actually is.
function DietaryBox({ value, onClick, className = 'w-5 h-5' }) {
  return (
    <button
      onClick={onClick}
      title={value ? 'Dietary — click to clear' : 'Click to flag dietary'}
      className={`${className} rounded border ${value ? 'bg-red-600 border-red-600' : 'bg-white border-stone-300'}`} />
  );
}

// Builds and opens a printable, landscape attendance sheet for one class/week — modelled on the
// paper Excel sheet centres already print for staff to take attendance from, so the layout
// (Child Name, DOB/Age, day-of-week boxes, Lunch, Parents Name + Phone No., Note) matches what
// staff already know how to read, rather than the on-screen spreadsheet's full column set.
function openPrintableAttendance({ className, ageRange, weekLabel, students, weekMon }) {
  const dayIso = (di) => weekMon ? isoAddDays(weekMon, di) : null;
  const rows = students.map((s, i) => {
    // Same rule as the on-screen grid: a suspended day prints as 'S' only if the child has a real
    // underlying attendance value for that day; a blank (unknown/non-attendance) day stays blank.
    // Exception: AUTO_BLANK_ON_SUSPENSION_END_NAMES students always print 'S' on every day of an
    // active suspension, known or not.
    const days = ['mon', 'tue', 'wed', 'thu', 'fri'].map((day, di) => {
      const iso = dayIso(di);
      // A day before the child's Started date never happened — blank regardless of pattern.
      const notYetStarted = iso && isIsoDate(s.originalStart) && iso < s.originalStart;
      const suspended = !notYetStarted && iso && s.suspensions?.some(sus => sus.start <= iso && sus.end >= iso);
      const stored = dayValueForDate(s, day, iso);
      return notYetStarted ? '' : suspended
        ? (AUTO_BLANK_ON_SUSPENSION_END_NAMES.includes(s.name) ? 'S' : (stored ? 'S' : ''))
        : stored;
    });
    const phone = escapeHtml(s.phone || '').replace(/\n/g, '<br>');
    const parents = escapeHtml(s.parents || '');
    // Holiday suspension dates used to be appended here too, but staff already see suspension
    // via the S day cells (see legend) — mixing the date-range text into Notes just cluttered it.
    const note = escapeHtml(s.note || '');
    const genderColour = GENDER[s.gender]?.colour || GENDER.X.colour;
    return `
      <tr>
        <td class="num">${i + 1}</td>
        <td class="name"><span class="gdot" style="background:${genderColour}"></span>${escapeHtml(s.name)}<div class="sub">${escapeHtml(s.nationality || '')}</div></td>
        <td>${s.dob ? escapeHtml(shortDate(s.dob)) : ''}</td>
        <td>${escapeHtml(ageFromDob(s.dob))}</td>
        <td>${s.returningDate ? escapeHtml(shortDate(s.returningDate)) : ''}</td>
        <td>${s.lastDate ? escapeHtml(shortDate(s.lastDate)) : ''}</td>
        ${days.map(d => `<td class="daybox ${d === 'F' ? 'full' : d === 'H' ? 'half' : d === 'S' ? 'susp' : ''}">${d || ''}</td>`).join('')}
        <td class="lunch${s.lunch === 'no' ? ' no' : ''}">${s.lunch === 'yes' ? '✓' : s.lunch === 'no' ? '✕' : ''}</td>
        <td class="lunch${s.socialMedia === 'no' ? ' no' : ''}">${s.socialMedia === 'yes' ? '✓' : s.socialMedia === 'no' ? '✕' : ''}</td>
        <td class="dietary${s.dietary ? ' flagged' : ''}"></td>
        <td>${parents}</td>
        <td>${phone}</td>
        <td class="note">${note}</td>
      </tr>`;
  }).join('');

  const totals = ['mon','tue','wed','thu','fri'].map((day, di) => {
    const iso = dayIso(di);
    const present = students.filter(s => {
      const suspended = iso && s.suspensions?.some(sus => sus.start <= iso && sus.end >= iso);
      if (suspended) return false;
      const v = dayValueForDate(s, day, iso);
      return v === 'F' || v === 'H';
    });
    return {
      full: present.filter(s => dayValueForDate(s, day, iso) === 'F').length,
      half: present.filter(s => dayValueForDate(s, day, iso) === 'H').length,
      lunch: present.filter(s => s.lunch === 'yes').length,
    };
  });

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(className)} — Attendance — ${escapeHtml(weekLabel)}</title>
<style>
  @page { size: landscape; margin: 10mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 0; padding: 16px; color: #1c1917; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .meta { font-size: 12px; color: #57534e; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th, td { border: 1px solid #d6d3d1; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f5f5f4; text-transform: uppercase; font-size: 9px; letter-spacing: 0.03em; }
  td.num { text-align: center; width: 24px; }
  td.name { font-weight: 600; min-width: 130px; }
  td.name .gdot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
  td.name .sub { font-weight: 400; font-size: 9.5px; color: #78716c; margin-left: 13px; }
  td.daybox { text-align: center; width: 22px; font-weight: 600; }
  td.daybox.full { background: #d1fae5; }
  td.daybox.half { background: #fef3c7; }
  td.daybox.susp { background: #dbeafe; }
  td.lunch { text-align: center; width: 24px; }
  td.lunch.no { color: #dc2626; font-weight: 700; }
  td.dietary { width: 24px; text-align: center; }
  td.dietary.flagged { background: #dc2626; }
  td.note { min-width: 140px; font-size: 9.5px; }
  tfoot td { font-weight: 700; background: #f5f5f4; }
  .legend { margin-top: 10px; font-size: 10px; color: #57534e; display: flex; gap: 16px; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  @media print { body { padding: 0; } * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; } }
</style>
</head>
<body>
  <h1>${escapeHtml(className)}${ageRange ? ` (${escapeHtml(ageRange)})` : ''}</h1>
  <div class="meta">Occupancy period: ${escapeHtml(weekLabel)} &nbsp;·&nbsp; ${students.length} students</div>
  <table>
    <thead>
      <tr>
        <th>No</th><th>Child name</th><th>DOB</th><th>Age</th><th>Returning</th><th>Last day</th>
        <th>M</th><th>T</th><th>W</th><th>T</th><th>F</th>
        <th>Lunch</th><th>Social media</th><th>Dietary</th><th>Parents name</th><th>Phone no.</th><th>Note</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="6">Full day / Half day / Lunch</td>
        ${totals.map(t => `<td class="daybox">${t.full}/${t.half}</td>`).join('')}
        <td>${totals.reduce((a, t) => a + t.lunch, 0)}</td>
        <td colspan="5"></td>
      </tr>
    </tfoot>
  </table>
  <div class="legend">
    <span><span class="swatch" style="background:#d1fae5"></span> Full day (F)</span>
    <span><span class="swatch" style="background:#fef3c7"></span> Half day (H)</span>
    <span><span class="swatch" style="background:#dbeafe"></span> Holiday suspension (S)</span>
    <span><span class="swatch" style="background:#dc2626"></span> Dietary</span>
  </div>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  // Some browsers fire onload reliably for document.write'd content, others (Safari) don't —
  // guard with a flag so whichever fires first triggers the print dialog exactly once.
  let printed = false;
  const triggerPrint = () => { if (printed) return; printed = true; try { win.print(); } catch {} };
  win.onload = triggerPrint;
  setTimeout(triggerPrint, 300);
}

function titleCaseIfNeeded(s) {
  if (!s) return s;
  return s.split(' ').map(w => {
    if (!w) return w;
    if (w.toLowerCase() === w) return w[0].toUpperCase() + w.slice(1);
    return w;
  }).join(' ');
}

// `centre` disambiguates the generic "EL 2" / "PK" guesses: Canggu splits those into two named
// sub-rooms (Daffodil/Hibiscus, Saffron/Lavender) with their own distinctly-named sheets that are
// caught by the 'hib'/'saf'/'lav' branches below and never reach the generic branch. Sanur's real
// workbook has no such split — just one combined "EL 2" sheet and one combined "PK" sheet — so for
// Sanur the generic branch must resolve to Sanur's own combined class ids ('el2'/'pk'), not silently
// dump everyone into Canggu's Daffodil/Saffron rooms (which is what caused Sanur's per-class counts
// to look wrong — Hibiscus/Lavender always empty, Daffodil/Saffron holding both real sub-groups).
function guessClassFromText(s, centre) {
  if (!s) return null;
  const l = s.toLowerCase();
  if (l.includes('el 1') || l.includes('el1') || (l.includes('1-2') && !l.includes('2-3'))) return 'el1';
  if (l.includes('el2 hib') || l.includes('el2h') || l.includes('hibiscus')) return 'el2h';
  if (l.includes('pk saf') || l.includes('saffron')) return 'pks';
  if (l.includes('pk lav') || l.includes('lavender')) return 'pkl';
  if (l.includes('el 2') || l.includes('el2') || l.includes('daffodil') || l.includes('2-3')) return centre === 'sanur' ? 'el2' : 'el2d';
  if (l.includes('pre k') || l.includes('pre-k') || l.includes('pk')) return centre === 'sanur' ? 'pk' : 'pks';
  if (l.includes('jr') || l.includes('jun')) return 'jrk';
  if (l.includes('kind')) return 'kg';
  return null;
}

// Boilerplate footer lines that form-notification emails (e.g. Tally) tack on after the
// actual submitted fields — "Manage Submissions", "Does this submission look like spam?
// Report it here.", etc. These carry no colon, so without this guard they get swallowed as
// a continuation of whatever the last field was (almost always the final "anything else"
// notes question), making notes appear to contain spam-report boilerplate when the parent
// actually left that field blank.
const EMAIL_FOOTER_RE = /^(manage submissions|does this submission look like spam|report it here\.?|view (this )?submission online|unsubscribe|powered by)\b/i;

function parseEmail(text) {
  const lines = text.split('\n');
  // Build ordered (key, value) list, preserving order
  const ordered = [];
  let currentIdx = -1;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (EMAIL_FOOTER_RE.test(line)) break; // stop — everything from here on is footer boilerplate, not content
    // A field label is "Label: value" where Label is reasonable length, has no @, no URL
    const m = line.match(/^([^:]{1,100}):\s*(.*)$/);
    if (m && !m[1].includes('@') && !m[1].toLowerCase().startsWith('http') && !m[1].includes('://')) {
      ordered.push({ key: m[1].trim(), value: m[2].trim() });
      currentIdx = ordered.length - 1;
    } else if (currentIdx >= 0) {
      // Continuation line for multi-line values (e.g. the vaccinations list)
      ordered[currentIdx].value = (ordered[currentIdx].value ? ordered[currentIdx].value + '\n' : '') + line;
    }
  }

  const f = {};
  let pendingDetailFor = null;
  const norm = k => k.replace(/\s*\*+\s*$/, '').trim();

  for (const { key, value: rawValue } of ordered) {
    const k = norm(key);
    const v = rawValue || '';

    // Disambiguate "If yes, please supply us with more details." by what came before
    if (/^If yes,?\s*please supply/i.test(k)) {
      if (pendingDetailFor) {
        f[pendingDetailFor] = v;
        pendingDetailFor = null;
      }
      continue;
    }

    switch (k) {
      case 'Name (Person completing this form)': f.formCompletedBy = v; break;
      case 'Date of arrival to Bali': f.arrivalDate = v; break;
      case 'How long do you intend to stay in Bali?': f.intendedStay = v; break;
      case 'What classes are you interested in?':
        f.requestedClassRaw = v;
        f.requestedClass = guessClassFromText(v);
        break;
      case 'Which days are you looking to enrol?': f.daysRequested = v; break;
      case 'Half Day or Full Day?': f.halfOrFull = v; break;
      case 'Preferred Start Date': f.preferredStart = v; break;
      case 'Childs Full Name':
      case "Child's Full Name":
        f.childName = titleCaseIfNeeded(v);
        f.childNameRaw = v;
        break;
      case 'Nationality': f.nationality = v; break;
      case 'Date of Birth': f.dob = normalizeDobToIso(v); break;
      case 'Gender': f.gender = v; break;
      case 'Native Language': f.nativeLanguage = v; break;
      case 'Parent 1 Contact': f.parent1Name = v; break;
      case 'Parent 1 Email': f.parent1Email = v; break;
      case 'Parent 1 Occupation': f.parent1Occupation = v; break;
      case 'Parent 1 Phone Number': f.parent1Phone = v; break;
      case 'Parent 2 Contact': f.parent2Name = v; break;
      case 'Parent 2 Email': f.parent2Email = v; break;
      case 'Parent 2 Occupation': f.parent2Occupation = v; break;
      case 'Parent 2 Phone Number': f.parent2Phone = v; break;
      case 'Sibling 1 Name': f.sibling1Name = v; break;
      case 'Sibling 1 D.O.B': f.sibling1Dob = v; break;
      case 'Sibling 2 Name': f.sibling2Name = v; break;
      case 'Sibling 2 D.O.B': f.sibling2Dob = v; break;
      case 'Sibling 3 Name': f.sibling3Name = v; break;
      case 'Sibling 3 D.O.B': f.sibling3Dob = v; break;
      case 'Pembantu / Nanny Name': f.nannyName = v; break;
      case 'Pembantu Phone Number': f.nannyPhone = v; break;
      case 'Family Doctor': f.doctorName = v; break;
      case 'Family Doctor Contact Details': f.doctorContact = v; break;
      case 'Has your child had all of their age appropriate vaccinations?':
        f.vaccinationsYesNo = v;
        pendingDetailFor = 'vaccinationsDetails';
        break;
      case 'Does your child have any medical disabilities or special educational needs?':
        f.medicalDisabilitiesYesNo = v;
        pendingDetailFor = 'medicalDisabilitiesDetails';
        break;
      case 'Does your child have any medical problems or allergies?':
        f.medicalProblemsYesNo = v;
        pendingDetailFor = 'medicalProblemsDetails';
        break;
      case 'Are there any food allergies that your child has?':
        f.foodAllergiesYesNo = v;
        pendingDetailFor = 'foodAllergiesDetails';
        break;
      case 'Does your child require an Epipen?':
        f.epipen = v;
        pendingDetailFor = null;
        break;
      case 'Is there anything else you would like us to know about your child?':
        f.otherNotes = v;
        pendingDetailFor = null;
        break;
      default:
        // Unknown field — ignore. We don't make stuff up.
        break;
    }
  }

  return f;
}

// ============================================================
// CSV BACKUP HELPERS
// ============================================================

const CSV_FLAT_COLS = [
  'id','name','gender','centre','classId','status',
  'dob','nationality','parents','phone','email',
  'mon','tue','wed','thu','fri','lunch','socialMedia','dietary',
  'note','originalStart','returningDate','lastDate','lengthOfStay',
  'bondPaid','bondReturned','bondAmount','periodFrom','periodUntil',
  'invoiceStatus','invoiceNote',
  'transitionTo','transitionDate',
  'archived','archivedAt',
  'nativeLanguage','arrivalDate','intendedStay','daysRequested','halfOrFull',
  'requestedClassRaw','formCompletedBy',
  'vaccinationsYesNo','vaccinationsDetails',
  'medicalDisabilitiesYesNo','medicalDisabilitiesDetails',
  'medicalProblemsYesNo','medicalProblemsDetails',
  'foodAllergiesYesNo','foodAllergiesDetails','epipen',
  'hasMedicalFlag','hasLastDayFlag',
];
const CSV_JSON_COLS = ['dietaryFlags','suspensions','scheduleChanges','siblings','prepay','parent1','parent2','nanny','doctor'];
const CSV_ALL_COLS = [...CSV_FLAT_COLS, ...CSV_JSON_COLS];

const BACKUP_SHEET_NAMES = { canggu: 'Canggu', sanur: 'Sanur' };

// Friendlier column headers for the exported workbook. Not exhaustive — any CSV_ALL_COLS field
// without an entry here just falls back to its raw name, so adding a field to CSV_ALL_COLS can
// never silently disappear from the export.
const BACKUP_COL_LABELS = {
  id: 'ID', name: 'Child Name', status: 'Status', classId: 'Class', centre: 'Centre', gender: 'Gender',
  dob: 'Date of Birth', nationality: 'Nationality',
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri',
  lunch: 'Lunch', socialMedia: 'Social Media', dietary: 'Dietary',
  parents: 'Parents', phone: 'Phone', email: 'Email',
  originalStart: 'Started', returningDate: 'Returning', lastDate: 'Last Day', lengthOfStay: 'Length of Stay',
  bondPaid: 'Bond Paid', bondReturned: 'Bond Returned', bondAmount: 'Bond Amount',
  periodFrom: 'Paid From', periodUntil: 'Paid Until', invoiceStatus: 'Invoice Status', invoiceNote: 'Invoice Note',
  note: 'Note', suspensions: 'Holiday Suspensions', scheduleChanges: 'Schedule Changes',
  transitionTo: 'Transition To', transitionDate: 'Transition Date',
  archived: 'Archived', archivedAt: 'Archived At',
  dietaryFlags: 'Dietary Flags', siblings: 'Siblings', prepay: 'Prepay Plan',
  parent1: 'Parent 1', parent2: 'Parent 2', nanny: 'Nanny', doctor: 'Doctor',
  nativeLanguage: 'Native Language', arrivalDate: 'Arrival Date', intendedStay: 'Intended Stay',
  daysRequested: 'Days Requested', halfOrFull: 'Half/Full Day', requestedClassRaw: 'Requested Class (raw)',
  formCompletedBy: 'Form Completed By',
  vaccinationsYesNo: 'Vaccinations (Y/N)', vaccinationsDetails: 'Vaccinations Details',
  medicalDisabilitiesYesNo: 'Medical Disabilities (Y/N)', medicalDisabilitiesDetails: 'Medical Disabilities Details',
  medicalProblemsYesNo: 'Medical Problems (Y/N)', medicalProblemsDetails: 'Medical Problems Details',
  foodAllergiesYesNo: 'Food Allergies (Y/N)', foodAllergiesDetails: 'Food Allergies Details', epipen: 'Epipen',
  hasMedicalFlag: 'Has Medical Flag', hasLastDayFlag: 'Has Last Day Flag',
};
const backupColLabel = (col) => BACKUP_COL_LABELS[col] || col;

// The columns staff actually look at go first; everything else (raw ids, rarely-touched inquiry
// form detail, internal flags) trails at the end. Built from CSV_ALL_COLS itself — anything not
// explicitly placed up front still ends up in the sheet exactly once, so a field can never be
// silently dropped from the export by forgetting to list it here.
const BACKUP_PRIORITY_COLS = [
  'name', 'status', 'classId', 'gender', 'dob', 'nationality',
  'mon', 'tue', 'wed', 'thu', 'fri', 'lunch', 'socialMedia', 'dietary',
  'parents', 'phone', 'email',
  'originalStart', 'returningDate', 'lastDate', 'lengthOfStay',
  'bondPaid', 'bondReturned', 'bondAmount', 'periodFrom', 'periodUntil', 'invoiceStatus', 'invoiceNote',
  'note', 'suspensions', 'scheduleChanges', 'transitionTo', 'transitionDate',
  'dietaryFlags', 'siblings', 'prepay', 'parent1', 'parent2', 'nanny', 'doctor',
];
const BACKUP_EXPORT_ORDER = [...BACKUP_PRIORITY_COLS, ...CSV_ALL_COLS.filter(c => !BACKUP_PRIORITY_COLS.includes(c))];

// Accepts either the friendly label or the raw field name as a header, so both newly-exported
// and older backups (and hand-edited files) parse the same way.
const BACKUP_LABEL_TO_COL = (() => {
  const m = {};
  CSV_ALL_COLS.forEach(col => {
    m[col] = col;
    const label = BACKUP_COL_LABELS[col];
    if (label) m[label] = col;
  });
  return m;
})();

function isBackupHeaderRow(headers) {
  const mapped = new Set(headers.map(h => BACKUP_LABEL_TO_COL[h] || h));
  return ['id', 'name', 'centre', 'classId', 'status'].every(f => mapped.has(f));
}

// Full-fidelity backup, as a real .xlsx workbook — scoped to a single centre (one file per
// school, never mixed together), so exporting from Sanur only ever gives you Sanur's data. Still
// exactly the same column set as before, just reordered/relabelled for readability, so it stays
// a perfect round-trip: parseGardenBackupWorkbook() below reads it straight back into the same
// student objects. Re-export weekly; if data is ever lost, re-importing the latest one via
// Import Excel restores that centre exactly as it was, without touching the other centre.
function exportStudentsToXLSX(students, centreId) {
  const wb = XLSX.utils.book_new();
  const group = students.filter(s => s.centre === centreId);
  const rows = [BACKUP_EXPORT_ORDER.map(backupColLabel), ...group.map(s => BACKUP_EXPORT_ORDER.map(col => {
    if (CSV_JSON_COLS.includes(col)) {
      const v = s[col];
      return v === null || v === undefined ? '' : JSON.stringify(v);
    }
    return String(s[col] ?? '');
  }))];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = BACKUP_EXPORT_ORDER.map(col => ({ wch: col === 'name' ? 22 : ['note', 'email', 'phone', 'nationality', 'parents'].includes(col) ? 26 : 13 }));
  const sheetName = BACKUP_SHEET_NAMES[centreId] || centreId;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const today = localIso(new Date());
  XLSX.writeFile(wb, `garden-backup-${sheetName.toLowerCase()}-${today}.xlsx`);
  return today;
}

function isGardenBackupCSV(text) {
  const firstLine = text.trimStart().split(/\r?\n/)[0] || '';
  return isBackupHeaderRow(parseCSVRow(firstLine));
}

function isGardenBackupWorkbook(workbook) {
  return workbook.SheetNames.some(name => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: false });
    return rows.length > 0 && isBackupHeaderRow(rows[0]);
  });
}

function coerceBackupRow(obj) {
  CSV_JSON_COLS.forEach(col => {
    if (obj[col]) {
      try { obj[col] = JSON.parse(obj[col]); } catch { obj[col] = col.endsWith('s') ? [] : null; }
    } else {
      obj[col] = col === 'dietaryFlags' || col === 'suspensions' || col === 'scheduleChanges' || col === 'siblings' ? [] : null;
    }
  });
  if (obj.id !== undefined) obj.id = Number(obj.id) || obj.id;
  if (obj.bondAmount !== undefined) obj.bondAmount = Number(obj.bondAmount) || 0;
  // Old backups stored lunch/socialMedia as booleans ('true'/'false'); newer ones store the
  // tri-state string directly ('yes'/'no'/''). Coerce either format to the tri-state scheme.
  obj.lunch = obj.lunch === 'true' || obj.lunch === true ? 'yes' : obj.lunch === 'no' ? 'no' : '';
  obj.socialMedia = obj.socialMedia === 'true' || obj.socialMedia === true ? 'yes' : obj.socialMedia === 'no' ? 'no' : '';
  obj.dietary = obj.dietary === 'true' || obj.dietary === true;
  obj.archived = obj.archived === 'true' || obj.archived === true;
  obj.hasMedicalFlag = obj.hasMedicalFlag === 'true' || obj.hasMedicalFlag === true;
  obj.hasLastDayFlag = obj.hasLastDayFlag === 'true' || obj.hasLastDayFlag === true;
  return obj;
}

function parseGardenBackupWorkbook(workbook) {
  const students = [];
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false });
    if (rows.length < 2 || !isBackupHeaderRow(rows[0])) continue;
    const headers = rows[0].map(h => BACKUP_LABEL_TO_COL[h] || h);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.every(c => String(c ?? '').trim() === '')) continue;
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = row[idx] ?? ''; });
      coerceBackupRow(obj);
      if (obj.name) students.push(obj);
    }
  }
  return students;
}

function parseGardenBackupCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  const headers = parseCSVRow(lines[0]).map(h => BACKUP_LABEL_TO_COL[h] || h);
  const students = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = parseCSVRow(line);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ''; });
    coerceBackupRow(obj);
    if (obj.name) students.push(obj);
  }
  return students;
}

function parseCSVRow(line) {
  const cells = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  cells.push(cur);
  return cells;
}

// ============================================================
// APP
// ============================================================

function GardenApp({ initialCentre = 'canggu' }) {
  const [students, setStudents] = useState([]);
  const [classes, setClasses] = useState([]);
  const [dbLoading, setDbLoading] = useState(true);
  const [addClassOpen, setAddClassOpen] = useState(false);
  const [editingClass, setEditingClass] = useState(null);
  // Remember whichever centre the admin was actually viewing (and which centres they've already
  // unlocked with a password) across a page refresh — previously this always reset to whichever
  // centre the login gate happened to store, silently bouncing an admin who'd switched to Canggu
  // back to Sanur on every reload even though they'd already unlocked both.
  const [centre, setCentre] = useState(() => {
    try {
      const saved = localStorage.getItem('garden_active_centre');
      return (saved === 'canggu' || saved === 'sanur') ? saved : initialCentre;
    } catch { return initialCentre; }
  });
  const [centreUnlocked, setCentreUnlocked] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('garden_unlocked_centres') || 'null');
      if (saved && typeof saved === 'object') {
        return { canggu: !!saved.canggu || initialCentre === 'canggu', sanur: !!saved.sanur || initialCentre === 'sanur' };
      }
    } catch {}
    return { canggu: initialCentre === 'canggu', sanur: initialCentre === 'sanur' };
  });
  useEffect(() => { try { localStorage.setItem('garden_active_centre', centre); } catch {} }, [centre]);
  useEffect(() => { try { localStorage.setItem('garden_unlocked_centres', JSON.stringify(centreUnlocked)); } catch {} }, [centreUnlocked]);
  const [centreGateTarget, setCentreGateTarget] = useState(null); // which centre is being unlocked
  const [currentClassId, setCurrentClassId] = useState('el2d');
  // Classes with no `centre` (el1/jrk/kg) are shared by both centres; the rest are centre-specific
  // (Canggu's split el2d/el2h/pks/pkl vs Sanur's combined el2/pk) — this is the list every
  // centre-scoped consumer (sidebar, dropdowns, dashboard, import summary) should actually see.
  const centreClasses = useMemo(() => classes.filter(c => !c.centre || c.centre === centre), [classes, centre]);
  // Whenever the active centre changes (including on initial load), make sure currentClassId
  // actually belongs to that centre — otherwise switching to Sanur while still pointed at a
  // Canggu-only room (e.g. the 'el2d' default) would show a class page for a room Sanur doesn't have.
  useEffect(() => {
    if (classes.length === 0) return;
    if (!centreClasses.some(c => c.id === currentClassId)) setCurrentClassId(centreClasses[0]?.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centre, classes]);
  const [weekIdx, setWeekIdx] = useState(TODAY_WEEK_IDX);
  const [selectedStudentId, setSelectedStudentId] = useState(null);
  const [view, setView] = useState('class');
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [classesOpen, setClassesOpen] = useState(true);
  const [toast, setToast] = useState(null);
  const [showLeft, setShowLeft] = useState(false);

  // Undo/redo history — in-memory only (never persisted to localStorage/sessionStorage), so
  // it's always empty on a fresh page load and scoped to this tab's own session, same as
  // Google Docs. See applyHistoryEntry below for how this stays safe against another admin
  // editing the same shared (Supabase-backed) data at the same time.
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const MAX_HISTORY = 100;

  const CENTRE_PASSWORDS = { canggu: 'canggu2024', sanur: 'sanur2024' };

  const handleCentreSwitch = (c) => {
    if (centreUnlocked[c]) { setCentre(c); return; }
    setCentreGateTarget(c);
  };

  const todayIso = localIso(new Date());
  const showToast = m => { setToast(m); setTimeout(() => setToast(null), 3000); };

  // Supabase helpers
  const syncStudentToDb = (student) => {
    if (!supabase) return;
    supabase.from('students').upsert({ id: String(student.id), data: student })
      .then(({ error }) => { if (error) console.error('Student sync error:', error); });
  };
  const syncClassToDb = (cls) => {
    if (!supabase) return;
    supabase.from('classes').upsert({ id: cls.id, data: cls })
      .then(({ error }) => { if (error) console.error('Class sync error:', error); });
  };

  // Load data from Supabase on mount (with localStorage migration for first run)
  useEffect(() => {
    async function load() {
      if (!supabase) {
        // No Supabase config — fall back to localStorage
        try {
          const saved = localStorage.getItem('garden_students');
          const raw = saved ? JSON.parse(saved) : SEED_STUDENTS;
          const { students: migrated } = migrateHolidaySuspensionNotes(raw);
          setStudents(migrated);
        } catch { setStudents(SEED_STUDENTS); }
        setClasses(INITIAL_CLASSES);
        setDbLoading(false);
        return;
      }

      const [studentsRes, classesRes] = await Promise.all([
        supabase.from('students').select('data'),
        supabase.from('classes').select('data'),
      ]);

      let dbStudents = studentsRes.data?.map(r => r.data) || [];
      let dbClasses  = classesRes.data?.map(r => r.data)  || [];

      // One-time migration: if DB is empty, pull from localStorage
      if (dbStudents.length === 0) {
        try {
          const lsRaw = localStorage.getItem('garden_students');
          const lsStudents = lsRaw ? JSON.parse(lsRaw) : SEED_STUDENTS;
          const rows = lsStudents.map(s => ({ id: String(s.id), data: s }));
          await supabase.from('students').upsert(rows);
          dbStudents = lsStudents;
          if (lsRaw) {
            showToast(`Migrated ${lsStudents.length} students to shared database`);
            localStorage.removeItem('garden_students');
          }
        } catch { dbStudents = SEED_STUDENTS; }
      }

      if (dbClasses.length === 0) {
        await supabase.from('classes').upsert(INITIAL_CLASSES.map(c => ({ id: c.id, data: c })));
        dbClasses = INITIAL_CLASSES;
      }

      // One-time migration: tag Canggu's split EL2/PK sub-rooms with centre:'canggu' (older DB
      // rows predate the `centre` field and would otherwise show in Sanur's sidebar too), and add
      // Sanur's own combined el2/pk classes if this DB was seeded before they existed.
      const CANGGU_ONLY_CLASS_IDS = ['el2d', 'el2h', 'pks', 'pkl'];
      let classesChanged = false;
      dbClasses = dbClasses.map(c => {
        if (CANGGU_ONLY_CLASS_IDS.includes(c.id) && c.centre !== 'canggu') { classesChanged = true; return { ...c, centre: 'canggu' }; }
        return c;
      });
      INITIAL_CLASSES.filter(c => c.centre === 'sanur').forEach(sanurClass => {
        if (!dbClasses.some(c => c.id === sanurClass.id)) { dbClasses.push(sanurClass); classesChanged = true; }
      });
      if (classesChanged && supabase) {
        await supabase.from('classes').upsert(dbClasses.map(c => ({ id: c.id, data: c })));
      }

      // Any existing Sanur students already assigned to Canggu's split Daffodil/Hibiscus/Saffron/
      // Lavender ids (from before Sanur had its own combined el2/pk classes) need remapping — left
      // as-is they'd become invisible the moment those split classes are hidden from Sanur's view.
      const SANUR_CLASS_REMAP = { el2d: 'el2', el2h: 'el2', pks: 'pk', pkl: 'pk' };
      let sanurClassIdsChanged = false;
      dbStudents = dbStudents.map(s => {
        if (s.centre === 'sanur' && SANUR_CLASS_REMAP[s.classId]) { sanurClassIdsChanged = true; return { ...s, classId: SANUR_CLASS_REMAP[s.classId] }; }
        return s;
      });

      // Migrate any free-text HS notes into structured suspensions
      const { students: migratedStudents, migrationLog } = migrateHolidaySuspensionNotes(dbStudents);
      const changed = migrationLog.filter(l => l.status === 'migrated' || l.status === 'deduped');

      // Backfill the "Holiday Suspension" table column for students who already have structured
      // suspensions (added via the sidebar panel) but whose text column was never populated —
      // this happened for any suspension added before the panel started writing that field back,
      // and would otherwise stay permanently blank since nothing else regenerates it.
      let hsColumnBackfilled = false;
      // Lunch / Social media used to be plain booleans before the tri-state (blank/tick/red-X) UI
      // existed. Without converting old `true`/`false` values to the new 'yes'/''/'no' strings,
      // every existing student who had lunch/socialMedia === true would silently render as a
      // blank box (since the UI now compares against the string 'yes'), losing real data visually.
      let triStateMigrated = false;
      const toTriState = (v) => {
        if (v === true) return 'yes';
        if (v === false || v === undefined || v === null) return '';
        return v;
      };
      const backfilledStudents = migratedStudents.map(s => {
        let out = s;
        if ((s.suspensions?.length || 0) > 0 && !String(s.holidaySuspension || '').trim()) {
          hsColumnBackfilled = true;
          out = { ...out, holidaySuspension: formatSuspensionsNote(s.suspensions) };
        }
        if (typeof s.lunch === 'boolean' || typeof s.socialMedia === 'boolean') {
          triStateMigrated = true;
          out = { ...out, lunch: toTriState(out.lunch), socialMedia: toTriState(out.socialMedia) };
        }
        return out;
      });

      const { students: expiredCleared, cleared: expiredClearedNames } = clearExpiredSuspensionDays(backfilledStudents, todayIso);
      const { students: pendingPromoted, promoted: promotedNames } = promoteEnrolledPendingStudents(expiredCleared, todayIso);

      if ((changed.length > 0 || sanurClassIdsChanged || hsColumnBackfilled || triStateMigrated || expiredClearedNames.length > 0 || promotedNames.length > 0) && supabase) {
        // Persist migrated/deduped students (and any Sanur classId remap, HS column backfill,
        // lunch/socialMedia tri-state migration, expired-suspension day clearing, enrolled_pending
        // promotion) back to DB
        await supabase.from('students').upsert(pendingPromoted.map(s => ({ id: String(s.id), data: s })));
      }
      if (expiredClearedNames.length > 0) {
        console.info('[HS Expiry] Cleared weekly pattern for ended suspensions:', expiredClearedNames);
      }
      if (promotedNames.length > 0) {
        console.info('[Enrolled Pending] Auto-promoted to Enrolled on start date:', promotedNames);
      }
      if (migrationLog.length > 0) {
        const unparsed  = migrationLog.filter(l => l.status === 'unparsed');
        const migrated  = migrationLog.filter(l => l.status === 'migrated');
        const deduped   = migrationLog.filter(l => l.status === 'deduped');
        if (migrated.length)  console.info('[HS Migration] Late-migrated ranges:', migrated.map(l => `${l.name}: ${l.ranges.map(r=>r.start+'→'+r.end).join(', ')} (remaining note: "${l.remaining}")`));
        if (deduped.length)   console.info('[HS Migration] Removed duplicate chips:', deduped.map(l => `${l.name}: removed ${l.removed} duplicate(s)`));
        if (unparsed.length)  console.warn('[HS Migration] Could not parse:', unparsed.map(l => `${l.name}: "${l.note}"`));
        if (!migrated.length && !deduped.length && !unparsed.length) console.info('[HS Migration] All clean — nothing to fix.');
      }

      setStudents(pendingPromoted);
      setClasses(sortClasses(dbClasses));
      setDbLoading(false);
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flag to suppress realtime events during bulk import/reset operations
  const suppressRealtime = useRef(false);

  // Realtime: keep all browser tabs / devices in sync
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase.channel('garden-db')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, ({ eventType, new: n, old: o }) => {
        if (suppressRealtime.current) return;
        if (eventType === 'DELETE') {
          setStudents(prev => prev.filter(s => String(s.id) !== o.id));
        } else {
          setStudents(prev => {
            const idx = prev.findIndex(s => String(s.id) === n.id);
            return idx >= 0 ? prev.map((s, i) => i === idx ? n.data : s) : [...prev, n.data];
          });
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'classes' }, ({ eventType, new: n, old: o }) => {
        if (suppressRealtime.current) return;
        if (eventType === 'DELETE') {
          setClasses(prev => prev.filter(c => c.id !== o.id));
        } else {
          setClasses(prev => {
            const idx = prev.findIndex(c => c.id === n.id);
            return sortClasses(idx >= 0 ? prev.map((c, i) => i === idx ? n.data : c) : [...prev, n.data]);
          });
        }
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  // Auto-complete transitions whose date has arrived
  useEffect(() => {
    if (dbLoading) return;
    students.forEach(s => {
      if (s.transitionTo && isIsoDate(s.transitionDate) && s.transitionDate <= todayIso) {
        updateStudent(s.id, { classId: s.transitionTo, transitionTo: null, transitionDate: null });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayIso, dbLoading]);

  // Own-class students + incoming students (pending transitions into this class)
  // Exclude left/cancelled and students whose Last Day has already passed — those belong in All Students → Left only.
  // Pipeline students (inquiry/quote/invoice/waitlist) haven't started yet, so an imported "Last Date" for them
  // isn't a meaningful "already left" signal — filtering them out by it wrongly hid a small number of waitlist
  // students (present correctly in Inquiries, which doesn't apply this filter) from their own class page.
  const ownStudents   = students.filter(s => s.centre === centre && s.classId === currentClassId && !s.archived && !['left','cancelled'].includes(s.status) && (['inquiry','quote_sent','invoice_sent','wait_list','placement_fee','enrolled_pending'].includes(s.status) || !isIsoDate(s.lastDate) || s.lastDate >= todayIso));
  const incomingStudents = students.filter(s => s.centre === centre && s.transitionTo === currentClassId && !s.archived);
  const visibleStudents = [...ownStudents, ...incomingStudents.filter(s => s.classId !== currentClassId)];

  const currentClass = classes.find(c => c.id === currentClassId);

  // Close detail panel whenever class or page changes
  useEffect(() => { setSelectedStudentId(null); }, [currentClassId, view]);

  // ---- Raw student/class mutators — state + Supabase sync only, no history recording.
  // updateStudent/addStudent/addClass/etc. below wrap these with a pushHistory() call each,
  // so every distinct user action (one field commit, one add, one delete) becomes exactly one
  // undo step — undo/redo themselves call these raw versions directly so that undoing an
  // action doesn't itself get recorded as a new undoable action.
  const applyStudentPatchRaw = (id, patch) => {
    setStudents(prev => {
      const next = prev.map(s => s.id === id ? { ...s, ...patch } : s);
      const merged = next.find(s => s.id === id);
      if (merged) syncStudentToDb(merged);
      return next;
    });
  };
  const insertStudentRaw = (snapshot) => {
    setStudents(prev => prev.some(s => s.id === snapshot.id) ? prev : [...prev, snapshot]);
    syncStudentToDb(snapshot);
  };
  const removeStudentRaw = (id) => {
    setStudents(prev => prev.filter(s => s.id !== id));
    if (supabase) supabase.from('students').delete().eq('id', String(id));
  };
  const applyClassPatchRaw = (id, patch) => {
    setClasses(prev => {
      const next = prev.map(c => c.id === id ? { ...c, ...patch } : c);
      const merged = next.find(c => c.id === id);
      if (merged) syncClassToDb(merged);
      return next;
    });
  };
  const insertClassRaw = (snapshot) => {
    setClasses(prev => sortClasses(prev.some(c => c.id === snapshot.id) ? prev : [...prev, snapshot]));
    syncClassToDb(snapshot);
  };
  const removeClassRaw = (id) => {
    setClasses(prev => prev.filter(c => c.id !== id));
    if (supabase) supabase.from('classes').delete().eq('id', id);
  };

  // ---- Undo/redo history ----
  const pushHistory = (entry) => {
    setUndoStack(prev => {
      const next = [...prev, entry];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setRedoStack([]);
  };

  // Applies one history entry in the given direction ('undo' or 'redo'). For field-level
  // 'update' entries this only touches the exact fields that action changed — never the whole
  // row — and first checks each field's *current* live value still matches what this action
  // last set it to. If another admin has changed that same field since (via the realtime
  // shared DB), that field is skipped rather than overwritten, so undo can't clobber someone
  // else's newer edit; only fields untouched since this action get reverted/reapplied.
  const applyHistoryEntry = (entry, direction) => {
    const target = direction === 'undo' ? entry.before : entry.after;
    const expected = direction === 'undo' ? entry.after : entry.before;
    const list = entry.table === 'student' ? students : classes;
    const applyPatchRaw = entry.table === 'student' ? applyStudentPatchRaw : applyClassPatchRaw;
    const insertRaw = entry.table === 'student' ? insertStudentRaw : insertClassRaw;
    const removeRaw = entry.table === 'student' ? removeStudentRaw : removeClassRaw;

    if (entry.type === 'update') {
      const current = list.find(x => x.id === entry.id);
      if (!current) return { recordMissing: true };
      const patch = {};
      let skippedCount = 0;
      Object.keys(target).forEach(k => {
        if (current[k] === expected[k]) patch[k] = target[k];
        else skippedCount++;
      });
      if (Object.keys(patch).length > 0) applyPatchRaw(entry.id, patch);
      return { skippedCount };
    }
    if (entry.type === 'add') {
      if (direction === 'undo') removeRaw(entry.id); else insertRaw(entry.snapshot);
      return {};
    }
    if (entry.type === 'delete') {
      if (direction === 'undo') insertRaw(entry.snapshot); else removeRaw(entry.id);
      return {};
    }
    return {};
  };

  const undo = () => {
    if (undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    const result = applyHistoryEntry(entry, 'undo') || {};
    setUndoStack(s => s.slice(0, -1));
    setRedoStack(s => [...s, entry]);
    if (result.recordMissing) showToast('Undo skipped — that record no longer exists');
    else if (result.skippedCount) showToast(`Undo: ${result.skippedCount} field${result.skippedCount > 1 ? 's' : ''} skipped — changed by someone else since`);
  };
  const redo = () => {
    if (redoStack.length === 0) return;
    const entry = redoStack[redoStack.length - 1];
    const result = applyHistoryEntry(entry, 'redo') || {};
    setRedoStack(s => s.slice(0, -1));
    setUndoStack(s => [...s, entry]);
    if (result.recordMissing) showToast('Redo skipped — that record no longer exists');
    else if (result.skippedCount) showToast(`Redo: ${result.skippedCount} field${result.skippedCount > 1 ? 's' : ''} skipped — changed by someone else since`);
  };

  // Keyboard shortcuts — Cmd/Ctrl+Z to undo, Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y to redo. Skipped
  // while a text input/textarea is actively focused so native in-field text undo still works.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      if (key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      else if (key === 'z') { e.preventDefault(); undo(); }
      else if (key === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoStack, redoStack, students, classes]);

  // Class CRUD
  const addClass = (cls) => {
    const id = cls.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') + '_' + Date.now().toString(36).slice(-4);
    const newCls = { ...cls, id, fullName: cls.fullName || cls.name, centre };
    pushHistory({ table: 'class', type: 'add', id, snapshot: newCls });
    insertClassRaw(newCls);
    showToast(`Added class "${cls.name}"`);
  };
  const updateClass = (id, patch) => {
    const current = classes.find(c => c.id === id);
    if (current) {
      const before = {};
      Object.keys(patch).forEach(k => { before[k] = current[k]; });
      pushHistory({ table: 'class', type: 'update', id, before, after: { ...patch } });
    }
    applyClassPatchRaw(id, patch);
  };
  const deleteClass = (id) => {
    const c = classes.find(x => x.id === id);
    const studentsInClass = students.filter(s => s.classId === id && !s.archived);
    if (studentsInClass.length > 0) {
      showToast(`Can't delete "${c?.name}" — ${studentsInClass.length} active students. Move or archive them first.`);
      return;
    }
    if (c) pushHistory({ table: 'class', type: 'delete', id, snapshot: c });
    removeClassRaw(id);
    if (currentClassId === id) setCurrentClassId(centreClasses[0]?.id);
    showToast(`Removed class "${c?.name}"`);
  };

  // Add student manually
  const addStudent = (data) => {
    const newId = (students.length === 0 ? 0 : Math.max(...students.map(s => s.id))) + 1;
    const newStudent = {
      id: newId, name: data.name || 'Unnamed', gender: data.gender || 'X',
      centre, classId: data.classId || currentClassId, status: data.status || 'enrolled',
      dob: data.dob || '', nationality: data.nationality || '', parents: data.parents || '',
      phone: data.phone || '', email: data.email || '',
      mon: data.mon || '', tue: data.tue || '', wed: data.wed || '', thu: data.thu || '', fri: data.fri || '',
      lunch: data.lunch || '', socialMedia: data.socialMedia || '', note: data.note || '', dietaryFlags: [], suspensions: [],
      originalStart: data.originalStart || '', returningDate: '', lastDate: '',
      lengthOfStay: data.lengthOfStay || 'Long term',
      bondPaid: '', bondAmount: 0, periodFrom: '', periodUntil: '',
      invoiceStatus: 'not_sent', invoiceNote: '', prepay: null, siblings: [],
    };
    pushHistory({ table: 'student', type: 'add', id: newId, snapshot: newStudent });
    insertStudentRaw(newStudent);
    showToast(`Added ${data.name}`);
  };

  const updateStudent = (id, patch) => {
    const current = students.find(s => s.id === id);
    // Pipeline students (inquiry/quote_sent/invoice_sent/wait_list/placement_fee) often carry a
    // stale imported "Last Date" that has no real meaning until they've actually started. Every
    // status-changing code path (Inquiries "Enrolled" button, class-table status dropdown,
    // Move Class panel, etc.) funnels through here, so clearing it centrally — rather than
    // relying on each caller to remember — guarantees a newly-enrolled/wait-listed student
    // never silently vanishes from ownStudents/isStudentActive due to a leftover past date.
    if (current && patch.status && patch.status !== current.status
        && ['inquiry', 'quote_sent', 'invoice_sent', 'wait_list', 'placement_fee', 'enrolled_pending'].includes(current.status)
        && ['enrolled', 'suspended'].includes(patch.status)
        && patch.lastDate === undefined) {
      patch = { ...patch, lastDate: '' };
    }
    if (current) {
      const before = {};
      Object.keys(patch).forEach(k => { before[k] = current[k]; });
      pushHistory({ table: 'student', type: 'update', id, before, after: { ...patch } });
    }
    applyStudentPatchRaw(id, patch);
  };

  const handleExportAll = () => {
    const centreLabel = BACKUP_SHEET_NAMES[centre] || centre;
    const count = students.filter(s => s.centre === centre).length;
    const exportDate = exportStudentsToXLSX(students, centre);
    localStorage.setItem('garden_last_export', exportDate);
    showToast(`Exported ${count} ${centreLabel} students to garden-backup-${centreLabel.toLowerCase()}-${exportDate}.xlsx`);
  };
  const archiveStudent = (id) => {
    const s = students.find(x => x.id === id);
    updateStudent(id, { archived: true, archivedAt: new Date().toISOString() });
    setSelectedStudentId(null);
    showToast(`${s?.name} moved to archive — restore anytime from Archive`);
  };
  const restoreStudent = (id) => {
    const s = students.find(x => x.id === id);
    updateStudent(id, { archived: false, archivedAt: null });
    showToast(`${s?.name} restored`);
  };
  const permanentDelete = (id) => {
    const s = students.find(x => x.id === id);
    if (s) pushHistory({ table: 'student', type: 'delete', id, snapshot: s });
    removeStudentRaw(id);
    setSelectedStudentId(null);
    showToast(`${s?.name} permanently deleted`);
  };
  const cycleDay = (id, day) => {
    const s = students.find(x => x.id === id);
    if (!s) return;
    updateStudent(id, { [day]: { '': 'F', 'F': 'H', 'H': 'S', 'S': '' }[s[day] || ''] ?? '' });
  };

  const handleParsedConfirm = (p) => {
    const newId = Math.max(...students.map(s => s.id)) + 1;
    // Build siblings list — only include slots that have a name
    const siblings = [];
    if (p.sibling1Name) siblings.push({ name: p.sibling1Name, dob: p.sibling1Dob || '' });
    if (p.sibling2Name) siblings.push({ name: p.sibling2Name, dob: p.sibling2Dob || '' });
    if (p.sibling3Name) siblings.push({ name: p.sibling3Name, dob: p.sibling3Dob || '' });

    // Combine contact info with role tags, only if present
    const phoneLines = [];
    if (p.parent1Phone) phoneLines.push(`${p.parent1Phone} (M)`);
    if (p.parent2Phone) phoneLines.push(`${p.parent2Phone} (D)`);
    const emailLines = [p.parent1Email, p.parent2Email].filter(Boolean);
    const parentNames = [p.parent1Name, p.parent2Name].filter(Boolean).join(' / ');

    // Gender — only set if explicitly provided in the email
    let gender = 'X';
    if (p.gender) {
      const g = p.gender.toLowerCase();
      if (g.startsWith('f') || g.includes('girl')) gender = 'F';
      else if (g.startsWith('m') || g.includes('boy')) gender = 'M';
    }

    const newStudent = {
      id: newId,
      name: p.childName || p.childNameRaw || 'Unnamed child',
      gender,
      centre,
      classId: p.requestedClass || 'el2d',
      status: 'inquiry',
      // Core
      dob: p.dob || '',
      nationality: p.nationality || '',
      nativeLanguage: p.nativeLanguage || '',
      parents: parentNames,
      phone: phoneLines.join('\n'),
      email: emailLines.join('\n'),
      // Auto-fill schedule from parsed days/half-full fields
      ...(() => {
        const dayVal = (/half/i.test(p.halfOrFull)) ? 'H' : 'F';
        const dr = (p.daysRequested || '').toLowerCase();
        const has = (abbrs) => abbrs.some(a => dr.includes(a));
        const all5 = /every day|all 5|mon.*fri|full week/i.test(dr);
        return {
          mon: (all5 || has(['mon'])) ? dayVal : '',
          tue: (all5 || has(['tue'])) ? dayVal : '',
          wed: (all5 || has(['wed'])) ? dayVal : '',
          thu: (all5 || has(['thu'])) ? dayVal : '',
          fri: (all5 || has(['fri'])) ? dayVal : '',
          lunch: dayVal === 'F' ? 'yes' : '',
        };
      })(),
      // Inquiry-only fields (preserved verbatim from email)
      arrivalDate: p.arrivalDate || '',
      intendedStay: p.intendedStay || '',
      daysRequested: p.daysRequested || '',
      halfOrFull: p.halfOrFull || '',
      requestedClassRaw: p.requestedClassRaw || '',
      formCompletedBy: p.formCompletedBy || '',
      // Structured parent details
      parent1: { name: p.parent1Name || '', email: p.parent1Email || '', phone: p.parent1Phone || '', occupation: p.parent1Occupation || '' },
      parent2: { name: p.parent2Name || '', email: p.parent2Email || '', phone: p.parent2Phone || '', occupation: p.parent2Occupation || '' },
      // Family
      siblings,
      nanny: (p.nannyName || p.nannyPhone) ? { name: p.nannyName || '', phone: p.nannyPhone || '' } : null,
      doctor: (p.doctorName || p.doctorContact) ? { name: p.doctorName || '', contact: p.doctorContact || '' } : null,
      // Medical (all stored as-is, no inference)
      vaccinationsYesNo: p.vaccinationsYesNo || '',
      vaccinationsDetails: p.vaccinationsDetails || '',
      medicalDisabilitiesYesNo: p.medicalDisabilitiesYesNo || '',
      medicalDisabilitiesDetails: p.medicalDisabilitiesDetails || '',
      medicalProblemsYesNo: p.medicalProblemsYesNo || '',
      medicalProblemsDetails: p.medicalProblemsDetails || '',
      foodAllergiesYesNo: p.foodAllergiesYesNo || '',
      foodAllergiesDetails: p.foodAllergiesDetails || '',
      epipen: p.epipen || '',
      // Notes & billing
      note: p.otherNotes || '',
      dietaryFlags: [],
      suspensions: [],
      originalStart: p.preferredStart || '',
      returningDate: '',
      lastDate: '',
      lengthOfStay: p.intendedStay || '',
      bondPaid: '', bondAmount: 0, periodFrom: '', periodUntil: '',
      invoiceStatus: 'not_sent', invoiceNote: '', prepay: null,
    };
    pushHistory({ table: 'student', type: 'add', id: newId, snapshot: newStudent });
    insertStudentRaw(newStudent);
    setEmailModalOpen(false);
    showToast(`Added ${p.childName || 'new inquiry'} to the pipeline`);
  };

  if (dbLoading) return (
    <div style={{ background: '#FAF6EF', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Geist, sans-serif' }}>
      <div style={{ textAlign: 'center', color: '#8B8678' }}>
        <div style={{ fontFamily: 'Instrument Serif, Georgia, serif', fontSize: '2rem', marginBottom: '0.5rem', color: '#1B1A17' }}>The Garden</div>
        <div style={{ fontSize: '0.875rem' }}>Loading…</div>
      </div>
    </div>
  );

  return (
    <ClassesContext.Provider value={{ classes: centreClasses, setClasses, addClass, updateClass, deleteClass }}>
      <style>{FONT_IMPORT + `
        :root {
          --bg: #FAF6EF;
          --paper: #FFFCF7;
          --paper-2: #FCF8F0;
          --ink: #1B1A17;
          --ink-soft: #4D4940;
          --ink-faint: #8B8678;
          --line: #E8E0D2;
          --line-soft: #F1ECDF;
          --accent: #3C5A3C;
          --accent-soft: #E8EFE3;
          --terracotta: #B65A35;
          --girl: #F4B8D0;
          --boy: #A8C5DC;
        }
        body, html, #root { background: var(--bg); }
        .font-display { font-family: 'Instrument Serif', Georgia, serif; font-weight: 400; letter-spacing: -0.01em; }
        .font-body { font-family: 'Geist', -apple-system, sans-serif; }
        .font-mono { font-family: 'Geist Mono', monospace; }
        * { font-family: 'Geist', -apple-system, sans-serif; }
        .sticky-col { position: sticky; z-index: 2; }
        .sticky-col-last { position: sticky; z-index: 2; box-shadow: 4px 0 6px -4px rgba(0,0,0,0.08); }
        .sticky-col-header { position: sticky; background: var(--line-soft); z-index: 5; }
        .sticky-col-header-last { position: sticky; background: var(--line-soft); z-index: 5; box-shadow: 4px 0 6px -4px rgba(0,0,0,0.08); }
        .ss-table-container::-webkit-scrollbar { height: 10px; }
        .ss-table-container::-webkit-scrollbar-track { background: var(--line-soft); }
        .ss-table-container::-webkit-scrollbar-thumb { background: var(--line); border-radius: 5px; }
        .ss-top-scroll { height: 12px; }
        .ss-top-scroll::-webkit-scrollbar { height: 10px; -webkit-appearance: none; }
        .ss-top-scroll::-webkit-scrollbar-track { background: var(--line-soft); border-radius: 5px; }
        .ss-top-scroll::-webkit-scrollbar-thumb { background: var(--line); border-radius: 5px; }
        .ss-top-scroll::-webkit-scrollbar-thumb:hover { background: var(--ink-faint); }
      `}</style>

      <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
        <div className="flex h-screen">
          {/* SIDEBAR */}
          <aside className="w-64 border-r flex flex-col" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
            <div className="px-5 pt-6 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
              <div className="font-display text-2xl leading-none">The Garden</div>
              <div className="font-display italic text-sm mt-1" style={{ color: 'var(--ink-faint)' }}>admin</div>
            </div>
            <div className="px-3 pt-4">
              <div className="text-xs uppercase tracking-widest px-2 mb-2" style={{ color: 'var(--ink-faint)' }}>Centre</div>
              <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--line-soft)' }}>
                <button onClick={() => handleCentreSwitch('canggu')} className={`flex-1 text-xs py-1.5 rounded transition ${centre === 'canggu' ? 'bg-white shadow-sm font-medium' : 'opacity-70'}`}>Canggu</button>
                <button onClick={() => handleCentreSwitch('sanur')} className={`flex-1 text-xs py-1.5 rounded transition ${centre === 'sanur' ? 'bg-white shadow-sm font-medium' : 'opacity-70'}`}>Sanur</button>
              </div>
            </div>
            <nav className="px-3 pt-5 flex-1 overflow-y-auto">
              <NavItem icon={LayoutDashboard} label="Dashboard" active={view === 'dashboard'} onClick={() => setView('dashboard')} />
              <NavItem icon={FileText} label="Inquiries" active={view === 'inquiries'} onClick={() => setView('inquiries')} badge={students.filter(s => s.centre === centre && !s.archived && ['inquiry','quote_sent','invoice_sent','wait_list','placement_fee'].includes(s.status)).length} />
              <NavItem icon={TrendingUp} label="Forecast" active={view === 'forecast'} onClick={() => setView('forecast')} />
              <button onClick={() => setClassesOpen(o => !o)} className="w-full mt-4 mb-1 flex items-center justify-between px-3 py-1.5 text-xs uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
                <span>Classes</span>
                {classesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              {classesOpen && centreClasses.map(c => {
                const enrolled = students.filter(s => s.centre === centre && s.classId === c.id && (s.status === 'enrolled' || s.status === 'suspended') && isStudentActive(s)).length;
                const isActive = view === 'class' && currentClassId === c.id;
                const overCap = enrolled > c.capacity;
                return (
                  <div key={c.id} className="group flex items-stretch">
                    <button onClick={() => { setCurrentClassId(c.id); setView('class'); }}
                      className={`flex-1 flex items-center justify-between gap-2 px-3 py-1.5 rounded-md text-sm transition ${isActive ? 'bg-stone-900 text-white' : 'hover:bg-stone-100'}`}
                      style={!isActive ? { color: 'var(--ink-soft)' } : {}}>
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.dot }} />
                        <span className="truncate">{c.name}</span>
                      </span>
                      <span className={`text-xs font-mono ${overCap ? 'text-amber-500' : 'opacity-60'}`}>{enrolled}/{c.capacity}</span>
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setEditingClass(c); }} className="opacity-0 group-hover:opacity-60 hover:opacity-100 px-1.5 rounded transition" title="Edit class">
                      <Edit3 size={11} style={{ color: isActive ? 'white' : 'var(--ink-faint)' }} />
                    </button>
                  </div>
                );
              })}
              {classesOpen && (
                <button onClick={() => setAddClassOpen(true)} className="w-full flex items-center gap-2 px-3 py-1.5 mt-1 rounded-md text-xs transition hover:bg-stone-100" style={{ color: 'var(--ink-faint)' }}>
                  <Plus size={12} /> Add class
                </button>
              )}
              <div className="mt-4">
                <NavItem icon={Users} label="All students" active={view === 'all_students'} onClick={() => setView('all_students')} />
                <NavItem icon={BookOpen} label="Archive" active={view === 'archive'} onClick={() => setView('archive')} />
                <NavItem icon={Upload} label="Import Excel" onClick={() => setImportModalOpen(true)} />
                <NavItem icon={Settings} label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
              </div>
            </nav>
            <div className="border-t p-3" style={{ borderColor: 'var(--line)' }}>
              <div className="flex items-center gap-3 px-2 py-1.5">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium" style={{ background: 'var(--accent)', color: 'white' }}>J</div>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">Jenny</div>
                  <div className="text-xs truncate" style={{ color: 'var(--ink-faint)' }}>Director · admin</div>
                </div>
              </div>
            </div>
          </aside>

          {/* MAIN */}
          <main className="flex-1 flex flex-col overflow-hidden">
            <header className="border-b flex items-center justify-between px-8 h-16" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 p-0.5 rounded-md" style={{ border: '1px solid var(--line)' }}>
                  <button
                    onClick={undo}
                    disabled={undoStack.length === 0}
                    title="Undo (Cmd+Z)"
                    className="p-1 rounded transition disabled:opacity-30 disabled:cursor-not-allowed hover:bg-stone-100">
                    <Undo2 size={14} />
                  </button>
                  <button
                    onClick={redo}
                    disabled={redoStack.length === 0}
                    title="Redo (Cmd+Shift+Z)"
                    className="p-1 rounded transition disabled:opacity-30 disabled:cursor-not-allowed hover:bg-stone-100">
                    <Redo2 size={14} />
                  </button>
                </div>
                <Building2 size={16} style={{ color: 'var(--ink-faint)' }} />
                <span className="text-sm" style={{ color: 'var(--ink-soft)' }}>{centre === 'canggu' ? 'Canggu' : 'Sanur'}</span>
                <ChevronRight size={14} style={{ color: 'var(--ink-faint)' }} />
                <span className="text-sm font-medium">{view === 'class' ? currentClass?.fullName : view.charAt(0).toUpperCase() + view.slice(1)}</span>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => setView('inquiries')} className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-white transition hover:opacity-90" style={{ background: 'var(--accent)' }}>
                  <Plus size={14} /> New from email
                </button>
              </div>
            </header>

            {view === 'class' && (
              <ClassView
                currentClass={currentClass}
                students={ownStudents}
                incomingStudents={incomingStudents.filter(s => s.classId !== currentClassId)}
                weekIdx={weekIdx} setWeekIdx={setWeekIdx}
                onCycleDay={cycleDay} onUpdate={updateStudent}
                onSelectStudent={setSelectedStudentId}
                showLeft={showLeft} setShowLeft={setShowLeft}
                onImport={() => setImportModalOpen(true)}
                onGoToInquiries={() => setView('inquiries')}
                onUpdateClass={updateClass}
                onExportAll={handleExportAll}
                showToast={showToast}
              />
            )}
            {view === 'dashboard' && <DashboardView students={students.filter(s => s.centre === centre && !s.archived)} onJump={(cid) => { setCurrentClassId(cid); setView('class'); }} onExportAll={handleExportAll} />}
            {view === 'inquiries' && <InquiriesView students={students.filter(s => s.centre === centre && !s.archived)} onSelectStudent={setSelectedStudentId} onParsedConfirm={handleParsedConfirm} onUpdate={updateStudent} />}
            {view === 'all_students' && <AllStudentsView students={students.filter(s => s.centre === centre && !s.archived)} onSelectStudent={setSelectedStudentId} />}
            {view === 'archive' && <ArchiveView students={students.filter(s => s.centre === centre && s.archived)} onSelectStudent={setSelectedStudentId} onRestore={restoreStudent} onPermanentDelete={permanentDelete} />}
            {view === 'forecast' && <ForecastView students={students.filter(s => s.centre === centre && !s.archived)} />}
            {view === 'settings' && <SettingsView onResetData={async () => {
              suppressRealtime.current = true;
              try {
                if (supabase) {
                  await supabase.from('students').delete().neq('id', '__none__');
                  await supabase.from('classes').delete().neq('id', '__none__');
                }
              } finally {
                setTimeout(() => { suppressRealtime.current = false; }, 2000);
              }
              setStudents(SEED_STUDENTS);
              setClasses(INITIAL_CLASSES);
              if (supabase) {
                await supabase.from('students').upsert(SEED_STUDENTS.map(s => ({ id: String(s.id), data: s })));
                await supabase.from('classes').upsert(INITIAL_CLASSES.map(c => ({ id: c.id, data: c })));
              }
              showToast('All data cleared — showing demo data');
            }} />}
          </main>

          {selectedStudentId && (
            <StudentDetailPanel
              student={students.find(s => s.id === selectedStudentId)}
              onClose={() => setSelectedStudentId(null)}
              onUpdate={updateStudent}
              onArchive={archiveStudent}
              onRestore={restoreStudent}
              showToast={showToast}
            />
          )}
        </div>

        {emailModalOpen && <EmailParseModal onClose={() => setEmailModalOpen(false)} onConfirm={handleParsedConfirm} />}
        {importModalOpen && <ImportModal centre={centre} onClose={() => setImportModalOpen(false)} onConfirm={async (parsed, isBackup) => {
          let newStudents;
          if (isBackup) {
            newStudents = parsed;
          } else {
            // Sequential ids must start after the highest id already in use across BOTH centres —
            // starting from 1 here would collide with the other centre's existing student ids
            // (which is exactly the kind of "numbers getting mixed up" bug this whole fix targets).
            const nextId = students.length > 0 ? Math.max(...students.map(s => s.id)) + 1 : 1;
            newStudents = parsed.map((s, i) => ({
              id: nextId + i,
              name: s.name || 'Unnamed',
              gender: s.gender || 'X',
              centre,
              classId: s.classId || currentClassId,
              status: s.status || 'enrolled',
              dob: s.dob || '',
              nationality: s.nationality || '',
              parents: s.parents || '',
              phone: s.phone || '',
              email: s.email || '',
              mon: s.mon || '', tue: s.tue || '', wed: s.wed || '', thu: s.thu || '', fri: s.fri || '',
              lunch: s.lunch || '',
              socialMedia: s.socialMedia || '',
              note: s.note || '',
              holidaySuspension: s.holidaySuspension || '',
              dietaryFlags: [],
              suspensions: (parseHolidaySuspensionNote(s.holidaySuspension || '')?.ranges || []).map(r => ({ ...r, fromImport: true })),
              originalStart: s.originalStart || '',
              returningDate: '',
              lastDate: s.lastDate || '',
              lengthOfStay: s.lengthOfStay || '',
              bondPaid: s.bondPaid || '',
              bondAmount: 0,
              periodFrom: s.periodFrom || '',
              periodUntil: s.periodUntil || '',
              invoiceStatus: 'not_sent',
              invoiceNote: s.invoiceNote || '',
              prepay: null,
              siblings: [],
            }));
          }
          // A backup restore replaces every student belonging to whichever centre(s) are actually
          // present in the file being restored — backups are now exported one centre at a time,
          // so a Sanur-only backup must only ever touch Sanur's rows, never Canggu's. A regular
          // Excel import is likewise scoped to the single centre currently open — deleting
          // `.neq('id', '__none__')` (matches every row) here was the bug that wiped both
          // centres' data on any single-centre import.
          const backupCentres = new Set(newStudents.map(s => s.centre));
          const idsToDelete = isBackup
            ? students.filter(s => backupCentres.has(s.centre)).map(s => String(s.id))
            : students.filter(s => s.centre === centre).map(s => String(s.id));
          if (supabase) {
            suppressRealtime.current = true;
            try {
              if (idsToDelete.length > 0) {
                await supabase.from('students').delete().in('id', idsToDelete);
              }
              const rows = newStudents.map(s => ({ id: String(s.id), data: s }));
              for (let i = 0; i < rows.length; i += 100) {
                await supabase.from('students').upsert(rows.slice(i, i + 100));
              }
            } finally {
              // Resume realtime after a short delay (let the change events flush)
              setTimeout(() => { suppressRealtime.current = false; }, 2000);
            }
          }
          setStudents(prev => isBackup
            ? [...prev.filter(s => !backupCentres.has(s.centre)), ...newStudents]
            : [...prev.filter(s => s.centre !== centre), ...newStudents]);
          setImportModalOpen(false);
          showToast(`${isBackup ? 'Restored' : 'Imported'} ${newStudents.length} students`);
        }} />}
        {addClassOpen && <AddOrEditClassModal onClose={() => setAddClassOpen(false)} onSave={c => { addClass(c); setAddClassOpen(false); }} />}
        {editingClass && <AddOrEditClassModal existing={editingClass} onClose={() => setEditingClass(null)} onSave={c => { updateClass(editingClass.id, c); setEditingClass(null); }} onDelete={() => { deleteClass(editingClass.id); setEditingClass(null); }} />}
        {centreGateTarget && (
          <CentrePasswordGate
            centre={centreGateTarget}
            correctPassword={CENTRE_PASSWORDS[centreGateTarget]}
            onSuccess={() => {
              setCentreUnlocked(prev => ({ ...prev, [centreGateTarget]: true }));
              setCentre(centreGateTarget);
              setCentreGateTarget(null);
            }}
            onClose={() => setCentreGateTarget(null)}
          />
        )}

        {toast && (
          <div className="fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 text-sm" style={{ background: 'var(--ink)', color: 'white' }}>
            <Check size={14} /> {toast}
          </div>
        )}
      </div>
    </ClassesContext.Provider>
  );
}

// ============================================================
// CLASS VIEW (the meaty one)
// ============================================================

function ClassView({ currentClass, students, incomingStudents = [], weekIdx, setWeekIdx, onCycleDay, onUpdate, onSelectStudent, showLeft, setShowLeft, onImport, onGoToInquiries, onUpdateClass, onExportAll, showToast }) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeStatusFilters, setActiveStatusFilters] = useState([]);
  const currentTabRef = useRef(null);

  // Scroll current week tab into view on first render
  useEffect(() => {
    currentTabRef.current?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' });
  }, []);

  const scrollToToday = () => {
    setWeekIdx(TODAY_WEEK_IDX);
    setTimeout(() => currentTabRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }), 50);
  };

  const toggleStatusFilter = (key) => {
    setActiveStatusFilters(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const filterByStatus = (arr) => {
    if (activeStatusFilters.length === 0) return arr;
    return arr.filter(s => activeStatusFilters.includes(s.status));
  };

  // Week date range for the currently viewed week
  const weekMon = WEEKS[weekIdx]?.monDate;
  const weekFriDate = weekMon ? isoAddDays(weekMon, 4) : null;

  // A student is "active in this week" if:
  //   - their Started date is on or before the Friday of this week (or not set)
  //   - their Last Day is on or after the Monday of this week (or not set)
  const inWeek = (s) => {
    if (weekMon && isIsoDate(s.originalStart) && s.originalStart > weekFriDate) return false;
    if (weekFriDate && isIsoDate(s.lastDate) && s.lastDate < weekMon) return false;
    return true;
  };

  // `classId` only actually flips to the destination class once the REAL calendar date reaches
  // transitionDate (see the auto-complete-transitions effect above) — it does NOT change just
  // because the user is browsing a future week here. Without this extra check (applied only to
  // this — the origin — class's own roster, never to `incomingStudents`, which already handles
  // the destination side via incomingPromoted below), a student scheduled to move showed up
  // twice for any week on/after their move date: once still in this class's roster, and once
  // already "promoted" into the destination class's roster.
  const notYetTransitioned = (s) => !(s.transitionTo && weekFriDate && isIsoDate(s.transitionDate) && s.transitionDate <= weekFriDate);

  const filteredStudents = filterByStatus(students.filter(inWeek).filter(notYetTransitioned));
  const filteredIncoming = incomingStudents.filter(inWeek);

  // A real status flip from 'enrolled_pending' to 'enrolled' only happens once the REAL calendar
  // date reaches the Started date (see promoteEnrolledPendingStudents, run on load) — it does not
  // change just because staff are browsing a future week here. But browsing forward to that future
  // week should still preview them as active from that week on, the same way the day-cell grid
  // already previews future weeks — otherwise a student due to start next month looks like they've
  // vanished from every future week right up until someone happens to reload the app on the day.
  const effectiveStatusForWeek = (s) =>
    (s.status === 'enrolled_pending' && weekFriDate && isIsoDate(s.originalStart) && s.originalStart <= weekFriDate)
      ? 'enrolled' : s.status;

  const active = filteredStudents.filter(s => ['enrolled','suspended','extended_holiday'].includes(effectiveStatusForWeek(s)));
  // Pipeline students (inquiry/quote/invoice/waitlist) haven't started yet, so they don't have a
  // meaningful "active in this week" state — filtering them by inWeek hid anyone whose prospective
  // start date fell after the currently-viewed week, even though they belong in the pipeline list
  // regardless of which week is selected. Once their effective status for the viewed week becomes
  // 'enrolled' (see above), they move to `active` instead and are excluded here.
  // Order the pipeline list by how close each child actually is to starting — soonest Start date
  // at the top, furthest away at the bottom — rather than by which pipeline stage they're at, so
  // staff read it as a "who's coming next" queue. Anyone with no usable Start date (blank, or
  // free text like "tbc"/"August 10th" that never parsed into a real date) sorts to the bottom,
  // since there's no way to place them in the queue until a real date is entered.
  // This ordering applies to the Waitlist/Pipeline section only — the Active list is untouched.
  // Parsed exactly the way shortDate() renders these cells, so the queue order always matches the
  // dates staff actually see — imported values are often free text ("10 August 2026", "1.08.2026")
  // rather than real ISO dates, and a strict ISO check would wrongly dump those at the bottom.
  const startQueueKey = (s) => {
    const raw = s.originalStart;
    if (!raw || raw === 'tbc') return null;
    let dt = new Date(raw);
    if (isNaN(dt)) dt = new Date(normalizeDobToIso(raw));
    return isNaN(dt) ? null : dt.getTime();
  };
  const waitlist = filterByStatus(students)
    .filter(s => ['inquiry','quote_sent','invoice_sent','wait_list','placement_fee','enrolled_pending'].includes(s.status) && effectiveStatusForWeek(s) !== 'enrolled')
    .sort((a, b) => {
      const ak = startQueueKey(a), bk = startQueueKey(b);
      if (ak && bk) return ak - bk || compareByName(a, b);
      if (ak) return -1;
      if (bk) return 1;
      return compareByName(a, b);
    });
  const left = filteredStudents.filter(s => ['left','cancelled'].includes(s.status)).sort(compareByName);

  const enrolledCount = students.filter(s => s.status === 'enrolled' && isStudentActive(s)).length;
  const suspendedCount = students.filter(s => ['suspended','extended_holiday'].includes(s.status) && isStudentActive(s)).length;
  const capWarn = enrolledCount >= currentClass.capacity;
  const capacityPct = (enrolledCount / currentClass.capacity) * 100;

  // Daily totals — count F and H per day, excluding students on suspension that day (the grid
  // shows their normal F/H as 'S' for a suspended day, so they must not also count as present).
  const totals = ['mon','tue','wed','thu','fri'].map((day, di) => {
    const dayIso = weekMon ? isoAddDays(weekMon, di) : null;
    const activeNotSuspended = active.filter(s => {
      if (!dayIso) return true;
      return !s.suspensions?.some(sus => sus.start <= dayIso && sus.end >= dayIso);
    });
    const f = activeNotSuspended.filter(s => dayValueForDate(s, day, dayIso) === 'F').length;
    const h = activeNotSuspended.filter(s => dayValueForDate(s, day, dayIso) === 'H').length;
    return { day, f, h, total: f + h };
  });

  // Same "already joined this week" split SpreadsheetWithTopScroll applies to incoming students,
  // replicated here so the printed roster matches exactly who's shown on screen for this week.
  const incomingPromoted = filteredIncoming.filter(s => !isIsoDate(s.transitionDate) || (weekFriDate && s.transitionDate <= weekFriDate));
  const handlePrint = () => {
    openPrintableAttendance({
      className: currentClass.fullName,
      ageRange: currentClass.age,
      weekLabel: WEEKS[weekIdx]?.label || '',
      students: [...active, ...incomingPromoted].sort(compareByName),
      weekMon,
    });
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 pt-7 pb-16">
      {/* Header */}
      <div className="flex items-end justify-between gap-6 mb-5">
        <div>
          <div className="font-display text-4xl leading-none">{currentClass.fullName}</div>
          <div className="flex items-center gap-4 mt-3 text-sm" style={{ color: 'var(--ink-soft)' }}>
            <span>{currentClass.age}</span>
            <span className="opacity-30">·</span>
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${capWarn ? 'bg-red-500' : 'bg-emerald-500'}`} />
              <span className="font-mono">{enrolledCount}/<EditableCapacity value={currentClass.capacity} onSave={n => onUpdateClass(currentClass.id, { capacity: n })} /></span> enrolled
            </span>
            {suspendedCount > 0 && (<><span className="opacity-30">·</span><span className="font-mono">{suspendedCount}</span> on suspension / extended holiday</>)}
            <span className="opacity-30">·</span>
            <span><span className="font-mono">{waitlist.length}</span> in pipeline</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onGoToInquiries} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-white font-medium transition hover:opacity-90" style={{ background: 'var(--accent)' }}>
            <Plus size={12} /> Enrol new student
          </button>
          <div className="relative">
            <button
              onClick={() => setFilterOpen(o => !o)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition ${activeStatusFilters.length > 0 ? 'bg-stone-900 text-white border-stone-900' : 'hover:bg-white'}`}
              style={activeStatusFilters.length === 0 ? { borderColor: 'var(--line)' } : {}}>
              <Filter size={12} /> Filter {activeStatusFilters.length > 0 && `(${activeStatusFilters.length})`}
            </button>
            {filterOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-xl py-2 min-w-max" style={{ background: 'var(--paper)', borderColor: 'var(--line)' }}>
                  <div className="px-3 py-1 text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Filter by status</div>
                  {Object.entries(STATUSES).map(([k, v]) => (
                    <button key={k} onClick={() => toggleStatusFilter(k)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-stone-50 transition">
                      <span className={`w-1.5 h-1.5 rounded-full ${v.dot} shrink-0`} />
                      {v.label}
                      {activeStatusFilters.includes(k) && <Check size={10} className="ml-auto text-emerald-600" />}
                    </button>
                  ))}
                  {activeStatusFilters.length > 0 && (
                    <button onClick={() => setActiveStatusFilters([])} className="w-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition border-t mt-1" style={{ borderColor: 'var(--line)' }}>
                      Clear filters
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          <button onClick={onExportAll} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border hover:bg-white transition" style={{ borderColor: 'var(--line)' }}>
            <Download size={12} /> Export backup
          </button>
          <button onClick={onImport} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border hover:bg-white transition" style={{ borderColor: 'var(--line)' }}>
            <Upload size={12} /> Import Excel
          </button>
          <button onClick={handlePrint} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border hover:bg-white transition" style={{ borderColor: 'var(--line)' }}>
            <Printer size={12} /> Print
          </button>
        </div>
      </div>

      <div className="h-1 rounded-full mb-6 overflow-hidden" style={{ background: 'var(--line-soft)' }}>
        <div className="h-full transition-all" style={{ width: `${Math.min(capacityPct, 100)}%`, background: capWarn ? 'var(--terracotta)' : 'var(--accent)' }} />
      </div>

      {/* Week tabs */}
      {/* Week navigation */}
      <div className="mb-4 border-b" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center gap-2">
          <div className="overflow-x-auto flex-1">
            <div className="flex items-center gap-1 w-max">
              {WEEKS.map((w, i) => {
                const isToday = i === TODAY_WEEK_IDX;
                const isActive = i === weekIdx;
                return (
                  <button
                    key={w.id}
                    ref={isToday ? currentTabRef : null}
                    onClick={() => setWeekIdx(i)}
                    className={`px-4 py-2.5 text-sm border-b-2 transition -mb-px shrink-0 ${isActive && !isToday ? 'font-semibold' : ''} ${!isActive && !isToday ? 'border-transparent opacity-50 hover:opacity-80' : ''}`}
                    style={isToday && isActive
                      ? { color: '#fff', background: 'var(--accent)', borderColor: 'var(--accent)', borderRadius: '6px 6px 0 0', fontWeight: 700 }
                      : isToday
                        ? { color: 'var(--accent)', borderColor: 'var(--accent)', fontWeight: 600 }
                        : isActive
                          ? { color: 'var(--ink)', borderColor: 'var(--ink)' }
                          : { color: 'var(--ink-soft)' }}>
                    <span className="font-mono text-xs mr-2 opacity-60">{isToday ? '★' : `W${i + 1}`}</span>
                    {w.label}
                  </button>
                );
              })}
            </div>
          </div>
          {weekIdx !== TODAY_WEEK_IDX && (
            <button
              onClick={scrollToToday}
              className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-white font-medium transition hover:opacity-90 mr-1"
              style={{ background: 'var(--accent)' }}>
              <Calendar size={11} /> Current week
            </button>
          )}
        </div>
      </div>

      {/* The spreadsheet — horizontally scrollable with synced top scrollbar */}
      <SpreadsheetWithTopScroll active={active} incoming={filteredIncoming} waitlist={waitlist} left={left} totals={totals} students={filteredStudents} weekMon={WEEKS[weekIdx]?.monDate} onCycleDay={onCycleDay} onUpdate={onUpdate} onSelectStudent={onSelectStudent} showLeft={showLeft} setShowLeft={setShowLeft} showToast={showToast} />

      <div className="mt-4 text-xs flex items-center gap-2" style={{ color: 'var(--ink-faint)' }}>
        <Edit3 size={11} /> Click any cell to edit. Day cells cycle F → H → S → empty. Status cycles workflow. Scroll table sideways for more columns.
      </div>
    </div>
  );
}

function SpreadsheetWithTopScroll({ active, incoming = [], waitlist, left, totals, students, weekMon, onCycleDay, onUpdate, onSelectStudent, showLeft, setShowLeft, showToast }) {
  const topRef = useRef(null);
  const bottomRef = useRef(null);
  const [contentWidth, setContentWidth] = useState(1900);

  // Split incoming: no date = immediate join; date reached for viewed week = promoted; future date = still pending
  const weekFri = weekMon ? isoAddDays(weekMon, 4) : null;
  const incomingPromoted = incoming.filter(s => !isIsoDate(s.transitionDate) || (weekFri && s.transitionDate <= weekFri));
  const incomingPending  = incoming.filter(s => isIsoDate(s.transitionDate) && (!weekFri || s.transitionDate > weekFri)).sort(compareByName);
  const activeAndIncoming = [...active, ...incomingPromoted].sort(compareByName);

  // Sync the two scrollers
  useEffect(() => {
    const top = topRef.current;
    const bot = bottomRef.current;
    if (!top || !bot) return;

    let syncing = false;
    const onTopScroll = () => {
      if (syncing) return;
      syncing = true;
      bot.scrollLeft = top.scrollLeft;
      requestAnimationFrame(() => { syncing = false; });
    };
    const onBotScroll = () => {
      if (syncing) return;
      syncing = true;
      top.scrollLeft = bot.scrollLeft;
      requestAnimationFrame(() => { syncing = false; });
    };
    top.addEventListener('scroll', onTopScroll);
    bot.addEventListener('scroll', onBotScroll);

    // Measure actual content width
    const measure = () => {
      const inner = bot.querySelector('table');
      if (inner) setContentWidth(inner.scrollWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (bot.querySelector('table')) ro.observe(bot.querySelector('table'));

    return () => {
      top.removeEventListener('scroll', onTopScroll);
      bot.removeEventListener('scroll', onBotScroll);
      ro.disconnect();
    };
  }, []);

  return (
    <>
      {/* Top scrollbar — sticks to the top so you can scroll sideways without going back up */}
      <div ref={topRef} className="ss-top-scroll overflow-x-auto rounded-t-lg border border-b-0" style={{ borderColor: 'var(--line)', background: 'var(--paper)', position: 'sticky', top: 0, zIndex: 20 }}>
        <div style={{ width: contentWidth, height: 12 }} />
      </div>

      <div className="rounded-b-lg border overflow-hidden" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
        <div ref={bottomRef} className="ss-table-container overflow-x-auto">
          <table className="text-sm" style={{ minWidth: '2410px' }}>
            <colgroup>
              <col style={{ width: '40px' }} />
              <col style={{ width: '240px' }} />
              <col style={{ width: '140px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '80px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '90px' }} />
              <col style={{ width: '40px' }} />
              <col style={{ width: '40px' }} />
              <col style={{ width: '40px' }} />
              <col style={{ width: '40px' }} />
              <col style={{ width: '40px' }} />
              <col style={{ width: '55px' }} />
              <col style={{ width: '55px' }} />
              <col style={{ width: '70px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '190px' }} />
              <col style={{ width: '160px' }} />
              <col style={{ width: '260px' }} />
              <col style={{ width: '170px' }} />
              <col style={{ width: '70px' }} />
            </colgroup>
            <thead>
              <tr className="text-xs uppercase tracking-wider border-b" style={{ borderColor: 'var(--line)', background: 'var(--line-soft)', color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>
                <th className="text-left font-medium px-3 py-2.5 sticky-col-header" style={{ left: 0 }}>No</th>
                <th className="text-left font-medium px-3 py-2.5 sticky-col-header-last" style={{ left: '40px' }}>Child</th>
                <th className="text-left font-medium px-3 py-2.5">Status</th>
                <th className="text-left font-medium px-3 py-2.5">DOB</th>
                <th className="text-left font-medium px-3 py-2.5">Age</th>
                <th className="text-left font-medium px-3 py-2.5">Start date</th>
                <th className="text-left font-medium px-3 py-2.5">Returning</th>
                <th className="text-left font-medium px-3 py-2.5">Last day</th>
                <th className="text-left font-medium px-3 py-2.5">Length</th>
                <th className="text-center font-medium px-2 py-2.5">M</th>
                <th className="text-center font-medium px-2 py-2.5">T</th>
                <th className="text-center font-medium px-2 py-2.5">W</th>
                <th className="text-center font-medium px-2 py-2.5">T</th>
                <th className="text-center font-medium px-2 py-2.5">F</th>
                <th className="text-center font-medium px-2 py-2.5">Lunch</th>
                <th className="text-center font-medium px-2 py-2.5">Social media</th>
                <th className="text-center font-medium px-2 py-2.5">Dietary</th>
                <th className="text-left font-medium px-3 py-2.5">Bond paid</th>
                <th className="text-left font-medium px-3 py-2.5">Bond returned</th>
                <th className="text-left font-medium px-3 py-2.5">Paid from</th>
                <th className="text-left font-medium px-3 py-2.5">Paid until</th>
                <th className="text-left font-medium px-3 py-2.5">Invoice</th>
                <th className="text-left font-medium px-3 py-2.5">Parents</th>
                <th className="text-left font-medium px-3 py-2.5">Note</th>
                <th className="text-left font-medium px-3 py-2.5">Holiday suspension</th>
                <th className="text-left font-medium px-3 py-2.5">Transition</th>
                <th className="text-center font-medium px-2 py-2.5">HS/yr</th>
              </tr>
            </thead>
            <tbody>
              {/* ACTIVE (includes incoming students who have no date or whose date has arrived) — alphabetical by name */}
              <SectionDivider label="Active" count={activeAndIncoming.length} colour="var(--accent)" />
              {activeAndIncoming.map((s, idx) => (
                <StudentRow key={s.id} student={s} idx={idx} weekMon={weekMon} onCycleDay={onCycleDay} onUpdate={onUpdate} onSelectStudent={onSelectStudent} showToast={showToast} />
              ))}
              {/* Totals */}
              <tr className="border-t border-b font-medium text-xs" style={{ borderColor: 'var(--line)', background: 'var(--accent-soft)' }}>
                <td className="px-3 py-2 sticky-col" style={{ left: 0, background: 'var(--accent-soft)' }}></td>
                <td className="px-3 py-2 sticky-col-last uppercase tracking-wider" style={{ left: '40px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>Daily totals</td>
                <td colSpan={7}></td>
                {totals.map(t => (
                  <td key={t.day} className="px-2 py-2 text-center" style={{ color: 'var(--ink)' }}>
                    <div className="font-mono">{t.total}</div>
                    <div className="text-[10px] opacity-60 font-mono">{t.f}F·{t.h}H</div>
                  </td>
                ))}
                <td className="px-2 py-2 text-center font-mono" style={{ color: 'var(--ink)' }}>{active.filter(s => s.lunch === 'yes').length}</td>
                <td className="px-2 py-2 text-center font-mono" style={{ color: 'var(--ink)' }}>{active.filter(s => s.socialMedia === 'yes').length}</td>
                <td colSpan={9}></td>
              </tr>

              {/* TRANSITIONING IN — students whose join date hasn't arrived yet for this week */}
              {incomingPending.length > 0 && (
                <>
                  <SectionDivider label="Transitioning in" count={incomingPending.length} colour="#2563eb" />
                  {incomingPending.map((s, idx) => (
                    <StudentRow key={s.id} student={s} idx={idx} weekMon={weekMon} onCycleDay={onCycleDay} onUpdate={onUpdate} onSelectStudent={onSelectStudent} showToast={showToast} dimmed />
                  ))}
                </>
              )}

              {/* WAITLIST */}
              {waitlist.length > 0 && (
                <>
                  <SectionDivider label="Waitlist / Pipeline" count={waitlist.length} colour="var(--terracotta)" />
                  {waitlist.map((s, idx) => (
                    <StudentRow key={s.id} student={s} idx={idx} weekMon={weekMon} onCycleDay={onCycleDay} onUpdate={onUpdate} onSelectStudent={onSelectStudent} showToast={showToast} dimmed />
                  ))}
                </>
              )}

              {/* RECENTLY LEFT (collapsible) */}
              {left.length > 0 && (
                <>
                  <tr className="border-t" style={{ borderColor: 'var(--line)' }}>
                    <td colSpan={23} className="px-3 py-1.5 sticky-col" style={{ background: 'var(--paper-2)' }}>
                      <button onClick={() => setShowLeft(o => !o)} className="flex items-center gap-2 text-xs uppercase tracking-wider" style={{ color: 'var(--ink-faint)' }}>
                        {showLeft ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        Recently left
                        <span className="font-mono opacity-60">{left.length}</span>
                      </button>
                    </td>
                  </tr>
                  {showLeft && left.map((s, idx) => (
                    <StudentRow key={s.id} student={s} idx={idx} weekMon={weekMon} onCycleDay={onCycleDay} onUpdate={onUpdate} onSelectStudent={onSelectStudent} showToast={showToast} dimmed />
                  ))}
                </>
              )}

              {students.length === 0 && incoming.length === 0 && (
                <tr><td colSpan={23} className="px-4 py-12 text-center text-sm" style={{ color: 'var(--ink-faint)' }}>No students in this class yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function EditableCell({ value, onSave, type = 'text', options, placeholder = '—', display, className = '', mono = false, faint = false, multiline = false }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value || '');

  React.useEffect(() => { setVal(value || ''); }, [value]);

  const save = () => { onSave(val); setEditing(false); };
  const cancel = () => { setVal(value || ''); setEditing(false); };

  if (editing) {
    if (type === 'select') {
      return (
        <select
          autoFocus value={val}
          onChange={e => { setVal(e.target.value); onSave(e.target.value); setEditing(false); }}
          onBlur={() => setEditing(false)}
          className="w-full px-1 py-0.5 border rounded text-xs bg-white focus:outline-none"
          style={{ borderColor: 'var(--accent)' }}>
          <option value="">—</option>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    if (multiline) {
      return (
        <textarea
          autoFocus
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={save}
          onKeyDown={e => { if (e.key === 'Escape') cancel(); }}
          rows={3}
          className={`w-full px-1 py-0.5 border rounded text-xs bg-white focus:outline-none resize-y ${mono ? 'font-mono' : ''}`}
          style={{ borderColor: 'var(--accent)' }}
        />
      );
    }
    return (
      <input
        autoFocus
        type={type === 'date' ? 'date' : 'text'}
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        className={`w-full px-1 py-0.5 border rounded text-xs bg-white focus:outline-none ${mono ? 'font-mono' : ''}`}
        style={{ borderColor: 'var(--accent)' }}
      />
    );
  }

  const shown = display !== undefined ? display : (value || '');
  const isEmpty = !value || value === '';

  return (
    <button
      onClick={() => setEditing(true)}
      className={`text-left w-full hover:bg-stone-100 rounded px-1 py-0.5 flex gap-1 group ${multiline ? 'items-start' : 'items-center truncate'} ${className} ${mono ? 'font-mono' : ''}`}
      style={{ color: isEmpty ? 'var(--ink-faint)' : (faint ? 'var(--ink-faint)' : 'var(--ink-soft)') }}>
      <span className={`flex-1 ${multiline ? 'whitespace-pre-line break-words min-w-0' : 'truncate'}`}>{isEmpty ? <span className="italic opacity-50">{placeholder}</span> : shown}</span>
      <Edit3 size={9} className={`opacity-0 group-hover:opacity-40 shrink-0 transition ${multiline ? 'mt-0.5' : ''}`} />
    </button>
  );
}

function EditableCapacity({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  React.useEffect(() => { setVal(value); }, [value]);

  const commit = () => {
    const n = parseInt(val);
    if (!isNaN(n) && n > 0) onSave(n);
    else setVal(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        min="1"
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(value); setEditing(false); } }}
        className="inline-block w-14 px-1 py-0 border rounded font-mono text-sm"
        style={{ borderColor: 'var(--accent)', background: 'var(--bg)' }}
      />
    );
  }

  return (
    <button onClick={() => setEditing(true)} className="hover:bg-stone-100 rounded px-1 inline-flex items-center gap-1 transition group" title="Click to change capacity">
      {value}
      <Edit3 size={9} className="opacity-0 group-hover:opacity-50 transition" />
    </button>
  );
}

function SectionDivider({ label, count, colour }) {
  return (
    <tr style={{ background: 'var(--paper-2)' }}>
      <td colSpan={23} className="px-3 py-1.5 sticky-col" style={{ background: 'var(--paper-2)', left: 0 }}>
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider" style={{ color: colour }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: colour }} />
          {label}
          <span className="font-mono opacity-60">{count}</span>
        </div>
      </td>
    </tr>
  );
}

// Lets staff set a future change to a child's weekly F/H/S pattern (e.g. "add Wednesday from 27
// Jul") without touching what past/current weeks already show. Mirrors SuspensionSection's
// dated-list UI; the main grid (StudentRow) and the printable sheet read scheduleChanges via
// dayValueForDate() so a change only takes effect for dates on/after its effectiveDate.
function ScheduleChangeSection({ student, onUpdate }) {
  const [adding, setAdding] = useState(false);
  const [editIdx, setEditIdx] = useState(null);
  const [effectiveDate, setEffectiveDate] = useState('');
  const [days, setDays] = useState({ mon: '', tue: '', wed: '', thu: '', fri: '' });
  const raw = student.scheduleChanges || [];
  const changes = raw.slice().sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const todayIso = localIso(new Date());

  const openAdd = () => {
    setEditIdx(null);
    setEffectiveDate('');
    setDays({
      mon: dayValueForDate(student, 'mon', todayIso),
      tue: dayValueForDate(student, 'tue', todayIso),
      wed: dayValueForDate(student, 'wed', todayIso),
      thu: dayValueForDate(student, 'thu', todayIso),
      fri: dayValueForDate(student, 'fri', todayIso),
    });
    setAdding(true);
  };
  const openEdit = (c) => {
    setEditIdx(raw.indexOf(c));
    setEffectiveDate(c.effectiveDate);
    setDays({ mon: c.mon || '', tue: c.tue || '', wed: c.wed || '', thu: c.thu || '', fri: c.fri || '' });
    setAdding(true);
  };
  const cancel = () => { setAdding(false); setEditIdx(null); setEffectiveDate(''); };
  const cycleDay = (key) => setDays(d => ({ ...d, [key]: { '': 'F', 'F': 'H', 'H': 'S', 'S': '' }[d[key] || ''] ?? '' }));
  const save = () => {
    if (!effectiveDate) return;
    const entry = { effectiveDate, ...days };
    const updated = editIdx !== null ? raw.map((c, i) => i === editIdx ? entry : c) : [...raw, entry];
    onUpdate({ scheduleChanges: updated });
    cancel();
  };
  const del = (c) => onUpdate({ scheduleChanges: raw.filter(x => x !== c) });

  return (
    <Section title={`Scheduled changes  ${changes.length}`}>
      {changes.map((c, i) => (
        <div key={i} className="text-xs py-1.5 border-b last:border-0 flex items-center justify-between gap-2" style={{ color: 'var(--ink-soft)', borderColor: 'var(--line-soft)' }}>
          <span>
            <span className="font-mono mr-2 opacity-60">{i + 1}.</span>
            From {shortDate(c.effectiveDate)}: {['mon', 'tue', 'wed', 'thu', 'fri'].map((k, di) => `${['M', 'T', 'W', 'T', 'F'][di]}${c[k] || '·'}`).join(' ')}
          </span>
          <div className="flex gap-1 shrink-0">
            <button onClick={() => openEdit(c)} className="p-0.5 rounded hover:bg-stone-100 transition" title="Edit"><Edit3 size={10} /></button>
            <button onClick={() => del(c)} className="p-0.5 rounded hover:bg-red-50 text-red-400 transition" title="Delete"><Trash2 size={10} /></button>
          </div>
        </div>
      ))}
      {changes.length === 0 && !adding && <div className="text-xs italic" style={{ color: 'var(--ink-faint)' }}>No upcoming changes</div>}
      {adding ? (
        <div className="mt-2 flex flex-col gap-2">
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--ink-faint)' }}>Effective from</label>
            <input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} className="w-full text-xs border rounded px-2 py-1.5" style={{ borderColor: 'var(--line)' }} />
          </div>
          <div className="flex gap-1">
            {['mon', 'tue', 'wed', 'thu', 'fri'].map((key, i) => {
              const v = days[key];
              return (
                <div key={key} className="flex-1 text-center">
                  <div className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>{['M', 'T', 'W', 'T', 'F'][i]}</div>
                  <button onClick={() => cycleDay(key)} className={`h-9 w-full rounded flex items-center justify-center text-sm font-mono font-medium ${v === 'F' ? 'bg-emerald-100 text-emerald-900' : v === 'H' ? 'bg-amber-100 text-amber-900' : v === 'S' ? 'bg-blue-100 text-blue-700' : 'bg-stone-100 text-stone-300'}`}>{v || '·'}</button>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={!effectiveDate} className="flex-1 py-1.5 rounded text-xs text-white font-medium disabled:opacity-40" style={{ background: 'var(--accent)' }}>
              {editIdx !== null ? 'Save changes' : 'Add'}
            </button>
            <button onClick={cancel} className="px-3 py-1.5 rounded text-xs border" style={{ borderColor: 'var(--line)' }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={openAdd} className="mt-2 w-full py-1.5 rounded border border-dashed text-xs flex items-center justify-center gap-1.5 hover:bg-stone-50 transition" style={{ borderColor: 'var(--line)', color: 'var(--ink-soft)' }}>
          <Plus size={11} /> Add schedule change
        </button>
      )}
    </Section>
  );
}

// Shared structured Start/End date-range editor for a student's Holiday Suspensions — the list
// of existing ranges (editable/deletable) plus an add/edit form with a "Save changes" button.
// Used both in the sidebar (SuspensionSection, wrapped in a <Section>) and inline in the main
// table's Holiday Suspension column (HolidaySuspensionCell) so both entry points give the exact
// same structured editor rather than the table cell falling back to free-text typing.
function SuspensionEditorBody({ student, onUpdate, showToast, onSaved }) {
  const [adding, setAdding] = useState(false);
  const [editIdx, setEditIdx] = useState(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const susp = student.suspensions || [];

  const openAdd = () => { setEditIdx(null); setStart(''); setEnd(''); setAdding(true); };
  const openEdit = (i) => { setEditIdx(i); setStart(susp[i].start); setEnd(susp[i].end); setAdding(true); };
  const cancel = () => { setAdding(false); setEditIdx(null); setStart(''); setEnd(''); };
  const save = () => {
    if (!start || !end || end < start) return;
    // Every add/edit resets daysCleared: false so the load-time sweep (clearExpiredSuspensionDays)
    // knows to wipe the weekly pattern once this specific entry's end date passes — a freshly
    // entered range is never grandfathered, only suspensions that predate this feature are.
    const entry = { start, end, daysCleared: false };
    const updated = editIdx !== null
      ? susp.map((s, i) => i === editIdx ? entry : s)
      : [...susp, entry];
    const todayIso = localIso(new Date());
    const alreadyEnded = end < todayIso && AUTO_BLANK_ON_SUSPENSION_END_NAMES.includes(student.name);
    const patch = { suspensions: updated, holidaySuspension: formatSuspensionsNote(updated) };
    if (alreadyEnded) {
      // Logging a suspension that's already over — blank the pattern immediately rather than
      // waiting for the next app load, and mark it cleared so the sweep doesn't touch it again.
      patch.suspensions = updated.map(s => s === entry ? { ...entry, daysCleared: true } : s);
      patch.mon = ''; patch.tue = ''; patch.wed = ''; patch.thu = ''; patch.fri = '';
    }
    onUpdate(patch);
    showToast?.('Holiday suspension saved — attendance grid updated');
    cancel();
    onSaved?.();
  };
  const del = (i) => {
    const updated = susp.filter((_, idx) => idx !== i);
    onUpdate({ suspensions: updated, holidaySuspension: formatSuspensionsNote(updated) });
    showToast?.('Holiday suspension removed — attendance grid updated');
    onSaved?.();
  };

  return (
    <>
      {susp.map((s, i) => (
        <div key={i} className="text-xs py-1.5 border-b last:border-0 flex items-center justify-between gap-2" style={{ color: 'var(--ink-soft)', borderColor: 'var(--line-soft)' }}>
          <span><span className="font-mono mr-2 opacity-60">{i+1}.</span>{shortDate(s.start)} – {shortDate(s.end)}</span>
          <div className="flex gap-1 shrink-0">
            <button onClick={() => openEdit(i)} className="p-0.5 rounded hover:bg-stone-100 transition" title="Edit"><Edit3 size={10} /></button>
            <button onClick={() => del(i)} className="p-0.5 rounded hover:bg-red-50 text-red-400 transition" title="Delete"><Trash2 size={10} /></button>
          </div>
        </div>
      ))}
      {susp.length === 0 && !adding && <div className="text-xs italic" style={{ color: 'var(--ink-faint)' }}>None this year</div>}
      {susp.length === 3 && (
        <div className="mt-2 px-2 py-1.5 rounded text-xs flex items-start gap-1.5" style={{ background: 'rgba(182,90,53,0.1)', color: 'var(--terracotta)' }}>
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> One suspension left this year
        </div>
      )}
      {susp.length >= 4 && (
        <div className="mt-2 px-2 py-1.5 rounded text-xs flex items-start gap-1.5 bg-red-50 text-red-700">
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> Cap reached — notify parent
        </div>
      )}
      {adding ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs block mb-1" style={{ color: 'var(--ink-faint)' }}>Start</label>
              <input type="date" value={start} onChange={e => setStart(e.target.value)} className="w-full text-xs border rounded px-2 py-1.5" style={{ borderColor: 'var(--line)' }} />
            </div>
            <div className="flex-1">
              <label className="text-xs block mb-1" style={{ color: 'var(--ink-faint)' }}>End</label>
              <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="w-full text-xs border rounded px-2 py-1.5" style={{ borderColor: 'var(--line)' }} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={!start || !end || end < start} className="flex-1 py-1.5 rounded text-xs text-white font-medium disabled:opacity-40" style={{ background: 'var(--accent)' }}>
              Save changes
            </button>
            <button onClick={cancel} className="px-3 py-1.5 rounded text-xs border" style={{ borderColor: 'var(--line)' }}>Cancel</button>
          </div>
        </div>
      ) : susp.length < 4 && (
        <button onClick={openAdd} className="mt-2 w-full py-1.5 rounded border border-dashed text-xs flex items-center justify-center gap-1.5 hover:bg-stone-50 transition" style={{ borderColor: 'var(--line)', color: 'var(--ink-soft)' }}>
          <Plus size={11} /> Add suspension
        </button>
      )}
    </>
  );
}

function SuspensionSection({ student, onUpdate, showToast }) {
  const susp = student.suspensions || [];
  return (
    <Section title={`Holiday suspensions  ${susp.length}/4`}>
      <SuspensionEditorBody student={student} onUpdate={onUpdate} showToast={showToast} />
    </Section>
  );
}

// Inline version of the same structured editor for the main table's Holiday Suspension column —
// clicking the cell opens the real Start/End date-range form (matching the sidebar panel)
// instead of falling back to typing free text into an EditableCell.
function HolidaySuspensionCell({ student, onUpdate, showToast }) {
  const [open, setOpen] = useState(false);
  const susp = student.suspensions || [];

  if (open) {
    return (
      <div className="text-xs" style={{ minWidth: '200px' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <span className="font-medium" style={{ color: 'var(--ink-soft)' }}>{susp.length}/4</span>
          <button onClick={() => setOpen(false)} className="p-0.5 rounded hover:bg-stone-100 transition" title="Close"><X size={11} /></button>
        </div>
        <SuspensionEditorBody student={student} onUpdate={onUpdate} showToast={showToast} onSaved={() => setOpen(false)} />
      </div>
    );
  }

  return (
    <button onClick={() => setOpen(true)} className="text-xs text-left w-full hover:underline">
      {susp.length === 0
        ? <span className="italic" style={{ color: 'var(--ink-faint)' }}>— add</span>
        : susp.map((s, i) => <div key={i} style={{ color: 'var(--ink-soft)' }}>{i + 1}. {shortDate(s.start)} – {shortDate(s.end)}</div>)}
    </button>
  );
}


function StudentRow({ student, idx, weekMon, onCycleDay, onUpdate, onSelectStudent, dimmed, showToast }) {
  const { classes } = useClasses();
  // Mirrors ClassView's effectiveStatusForWeek: the real status field only flips from
  // 'enrolled_pending' to 'enrolled' once the REAL calendar date reaches the Started date, but
  // browsing forward to that student's start week should already show the "Enrolled" badge for
  // that week, matching them already being listed in Active rather than Waitlist/Pipeline.
  const weekFriForRow = weekMon ? isoAddDays(weekMon, 4) : null;
  const displayStatusKey = (student.status === 'enrolled_pending' && weekFriForRow && isIsoDate(student.originalStart) && student.originalStart <= weekFriForRow)
    ? 'enrolled' : student.status;
  const status = STATUSES[displayStatusKey];
  const inv = INVOICE_STATUSES[student.invoiceStatus] || INVOICE_STATUSES.not_sent;
  // HS/yr counts how many separate suspension entries have been used this year (capped at 4),
  // matching the same count shown in the student panel's "Holiday suspensions X/4" and everywhere
  // else in the app — NOT total suspension weeks, which could make one long suspension alone
  // look like it used up the whole yearly allowance.
  const susCount = student.suspensions?.length || 0;

  // Which day cell (if any) just registered a click while suspended — briefly flashed as the
  // only confirmation a click landed, since the box itself always shows 'S' while suspended and
  // must never change to prove it (see the day-cell map below).
  const [flashDay, setFlashDay] = useState(null);

  const [statusOpen, setStatusOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const statusBtnRef = useRef(null);
  const openStatusMenu = () => {
    const rect = statusBtnRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setStatusOpen(true);
  };
  // Pipeline students move between the pre-enrolment stages, not to/from suspension.
  const isPipeline = ['inquiry', 'quote_sent', 'invoice_sent', 'wait_list', 'placement_fee', 'enrolled_pending'].includes(student.status);
  const statusOptions = isPipeline ? ['wait_list', 'placement_fee', 'invoice_sent', 'quote_sent', 'enrolled_pending', 'enrolled'] : ['suspended', 'enrolled'];
  const cycleInvoice = () => {
    const order = ['not_sent','sent','paid','prepay'];
    const i = order.indexOf(student.invoiceStatus || 'not_sent');
    onUpdate(student.id, { invoiceStatus: order[(i+1) % order.length] });
  };

  const rowBg = idx % 2 === 0 ? 'var(--paper)' : 'var(--paper-2)';
  const opacity = dimmed ? 0.7 : 1;

  return (
    <tr className="border-b group hover:shadow-sm transition" style={{ borderColor: 'var(--line-soft)', opacity, background: rowBg }}>
      <td className="px-3 py-2 text-xs font-mono sticky-col" style={{ color: 'var(--ink-faint)', left: 0, background: rowBg }}>{idx + 1}</td>
      <td className="px-3 py-2 sticky-col-last" style={{ left: '40px', background: rowBg }}>
        <button onClick={() => onSelectStudent(student.id)} className="text-left hover:underline flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: GENDER[student.gender]?.colour }} />
          <span>
            <span className="font-medium">{student.name}</span>
            <span className="block text-xs" style={{ color: 'var(--ink-faint)' }}>
              {student.nationality}
              {student.dietaryFlags?.length > 0 && <span className="ml-1.5 inline-flex items-center gap-0.5"><Pill size={9} /> diet</span>}
              {student.hasMedicalFlag && <span className="ml-1.5 inline-flex items-center gap-0.5"><Heart size={9} /> medical</span>}
              {student.transitionTo && <span className="ml-1.5 inline-flex items-center gap-0.5"><ArrowRight size={9} /> {classes.find(c => c.id === student.transitionTo)?.name}</span>}
              {student.hasLastDayFlag && <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber-700"><Calendar size={9} /> leaving</span>}
            </span>
          </span>
        </button>
      </td>
      <td className="px-3 py-2">
        <div className="relative inline-block">
          <button
            ref={statusBtnRef}
            onClick={() => statusOpen ? setStatusOpen(false) : openStatusMenu()}
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full border ${status.chip} whitespace-nowrap`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </button>
          {statusOpen && menuPos && createPortal(
            <>
              <div className="fixed inset-0 z-40" onClick={() => setStatusOpen(false)} />
              <div
                className="fixed z-50 rounded-md border shadow-xl py-1 min-w-max"
                style={{ top: menuPos.top, left: menuPos.left, background: 'var(--paper)', borderColor: 'var(--line)', overscrollBehavior: 'contain' }}
                onWheel={e => e.stopPropagation()}>
              {statusOptions.map(k => {
                const v = STATUSES[k];
                return (
                  <button
                    key={k}
                    onClick={() => {
                      // Pipeline students often carry a stale imported "Last Date" that has no real
                      // meaning until they've actually started — clear it when moving them into
                      // Enrolled so they aren't immediately treated as already left (see ownStudents).
                      const patch = { status: k };
                      if (isPipeline && k === 'enrolled') patch.lastDate = '';
                      onUpdate(student.id, patch);
                      setStatusOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-stone-50 transition ${student.status === k ? 'font-semibold' : ''}`}
                    style={{ color: 'var(--ink)' }}>
                    <span className={`w-1.5 h-1.5 rounded-full ${v.dot} shrink-0`} />
                    {v.label}
                    {student.status === k && <Check size={10} className="ml-auto" />}
                  </button>
                );
              })}
            </div>
            </>,
            document.body
          )}
        </div>
      </td>
      <td className="px-2 py-2 text-xs">
        <EditableCell value={student.dob} onSave={v => onUpdate(student.id, { dob: v })} type="date" display={student.dob ? shortDate(student.dob) : ''} mono />
      </td>
      <td className="px-3 py-2 text-xs font-mono" style={{ color: 'var(--ink-soft)' }}>{ageFromDob(student.dob)}</td>
      <td className="px-2 py-2 text-xs">
        <EditableCell value={student.originalStart} onSave={v => onUpdate(student.id, { originalStart: v })} type="date" display={student.originalStart ? shortDate(student.originalStart) : ''} mono />
      </td>
      <td className="px-2 py-2 text-xs">
        <EditableCell value={student.returningDate} onSave={v => onUpdate(student.id, { returningDate: v })} type="date" display={student.returningDate ? shortDate(student.returningDate) : ''} mono />
      </td>
      <td className="px-2 py-2 text-xs">
        <EditableCell value={student.lastDate} onSave={v => onUpdate(student.id, { lastDate: v })} type="date" display={student.lastDate ? shortDate(student.lastDate) : ''} mono />
      </td>
      <td className="px-2 py-2 text-xs">
        <EditableCell value={student.lengthOfStay} onSave={v => onUpdate(student.id, { lengthOfStay: v })} />
      </td>
      {['mon','tue','wed','thu','fri'].map((day, di) => {
        const dayIso = weekMon ? isoAddDays(weekMon, di) : null;
        // A day before the child's actual Started date never happened — show blank regardless of
        // their weekly pattern, even within their first week (e.g. starting Tuesday leaves Monday
        // of that same week blank rather than showing their normal Monday pattern).
        const notYetStarted = dayIso && isIsoDate(student.originalStart) && dayIso < student.originalStart;
        const suspended = !notYetStarted && dayIso && student.suspensions?.some(s => s.start <= dayIso && s.end >= dayIso);
        const scheduleChange = dayIso ? scheduleChangeForDate(student, dayIso) : null;
        const stored = dayValueForDate(student, day, dayIso);
        // While a day falls inside a Holiday Suspension: if the child has a real underlying F/H/S
        // value for that day (a known attendance day), the box always shows a plain 'S' — never
        // the actual letter. If the underlying value is blank (no known attendance that day), the
        // box stays blank — a suspension never invents an attendance day that wasn't there.
        // Clicking still cycles the real stored value completely silently either way — the box
        // never reveals the letter to "prove" the click worked; a brief flash is the only
        // confirmation. Do not default an unknown/blank day to 'S' under any circumstance.
        // Exception: AUTO_BLANK_ON_SUSPENSION_END_NAMES students always show 'S' on every day of
        // an active suspension, known or not — explicitly requested for this named list only.
        const effective = notYetStarted ? '' : suspended
          ? (AUTO_BLANK_ON_SUSPENSION_END_NAMES.includes(student.name) ? 'S' : (stored ? 'S' : ''))
          : stored;
        const locked = !!scheduleChange;
        const cellKey = `${student.id}:${day}`;
        return (
          <td key={day} className="px-1 py-2 text-center">
            <button
              onClick={() => {
                if (locked) return;
                onUpdate(student.id, { [day]: { '': 'F', 'F': 'H', 'H': 'S', 'S': '' }[stored] ?? '' });
                if (suspended) {
                  setFlashDay(cellKey);
                  setTimeout(() => setFlashDay(f => (f === cellKey ? null : f)), 300);
                }
              }}
              title={suspended ? 'Holiday suspension — click cycles the underlying value silently' : scheduleChange ? `Scheduled change from ${shortDate(scheduleChange.effectiveDate)} — edit in Schedule changes` : undefined}
              className={`w-7 h-7 rounded text-xs font-mono font-medium transition ${effective === 'F' ? 'bg-emerald-100 text-emerald-900' : effective === 'H' ? 'bg-amber-100 text-amber-900' : effective === 'S' ? 'bg-blue-100 text-blue-700' : 'text-stone-300 hover:bg-stone-100'} ${locked ? 'cursor-default' : ''} ${flashDay === cellKey ? 'ring-2 ring-emerald-400' : ''}`}>
              {effective || '·'}
            </button>
          </td>
        );
      })}
      <td className="px-3 py-2 text-center">
        <TriStateBox value={student.lunch} onClick={() => onUpdate(student.id, { lunch: cycleTriState(student.lunch) })} />
      </td>
      <td className="px-3 py-2 text-center">
        <TriStateBox value={student.socialMedia} onClick={() => onUpdate(student.id, { socialMedia: cycleTriState(student.socialMedia) })} />
      </td>
      <td className="px-3 py-2 text-center">
        <DietaryBox value={student.dietary} onClick={() => onUpdate(student.id, { dietary: !student.dietary })} />
      </td>
      <td className="px-2 py-2 text-xs">
        <EditableCell value={student.bondPaid} onSave={v => onUpdate(student.id, { bondPaid: v })} type="date" display={student.bondPaid ? shortDate(student.bondPaid) : ''} mono />
      </td>
      <td className="px-2 py-2 text-xs">
        <EditableCell value={student.bondReturned} onSave={v => onUpdate(student.id, { bondReturned: v })} placeholder="— add" display={student.bondReturned ? shortDate(student.bondReturned) : ''} mono />
      </td>
      <td className="px-2 py-2 text-xs">
        <EditableCell value={student.periodFrom} onSave={v => onUpdate(student.id, { periodFrom: v })} type="date" display={student.periodFrom ? shortDate(student.periodFrom) : ''} mono />
      </td>
      <td className="px-2 py-2 text-xs">
        <EditableCell value={student.periodUntil} onSave={v => onUpdate(student.id, { periodUntil: v })} type="date" display={student.periodUntil ? shortDate(student.periodUntil) : ''} mono />
      </td>
      <td className="px-3 py-2">
        <button onClick={cycleInvoice} className={`text-xs px-2 py-0.5 rounded font-medium ${inv.colour}`}>
          {inv.label}
        </button>
        {student.prepay && (
          <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--ink-faint)' }}>
            {student.prepay.completed}/{student.prepay.weeks}w
          </div>
        )}
        {!student.prepay && (
          <div className="mt-0.5">
            <EditableCell value={student.invoiceNote} onSave={v => onUpdate(student.id, { invoiceNote: v })} placeholder="— add note" className="italic" faint />
          </div>
        )}
      </td>
      <td className="px-2 py-2 text-xs">
        <EditableCell value={student.parents} onSave={v => onUpdate(student.id, { parents: v })} placeholder="— add parents" />
      </td>
      <td className="px-2 py-2 text-xs" style={{ minWidth: '260px' }}>
        {student.lastDate && <div className="text-xs font-semibold mb-0.5" style={{ color: '#dc2626' }}>LAST DAY {shortDate(student.lastDate)}</div>}
        <EditableCell value={student.note} onSave={v => onUpdate(student.id, { note: v })} placeholder="— add note" multiline />
      </td>
      <td className="px-2 py-2 text-xs" style={{ minWidth: '160px' }}>
        <HolidaySuspensionCell student={student} onUpdate={patch => onUpdate(student.id, patch)} showToast={showToast} />
      </td>
      <td className="px-2 py-2 text-xs">
        <TransitionCell student={student} onUpdate={onUpdate} />
      </td>
      <td className="px-2 py-2 text-center">
        <span className={`inline-flex items-center justify-center w-7 h-6 rounded text-xs font-mono font-medium ${susCount >= 4 ? 'bg-red-100 text-red-700' : susCount === 3 ? 'bg-amber-100 text-amber-800' : 'text-stone-500'}`}>
          {susCount}/4
        </span>
      </td>
    </tr>
  );
}

function TransitionCell({ student, onUpdate }) {
  const { classes } = useClasses();
  const [open, setOpen] = useState(false);
  const [destId, setDestId] = useState('');
  const [date, setDate] = useState('');

  const openPop = () => {
    setDestId(student.transitionTo || '');
    setDate(student.transitionDate || '');
    setOpen(true);
  };
  const save = () => {
    if (!destId) { clear(); return; }
    onUpdate(student.id, { transitionTo: destId, transitionDate: date || null });
    setOpen(false);
  };
  const clear = () => {
    onUpdate(student.id, { transitionTo: null, transitionDate: null });
    setOpen(false);
  };

  const dest = classes.find(c => c.id === student.transitionTo);
  const otherClasses = classes.filter(c => c.id !== student.classId);

  if (open) {
    return (
      <div className="flex flex-col gap-1.5 py-1" onClick={e => e.stopPropagation()}>
        <select value={destId} onChange={e => setDestId(e.target.value)} autoFocus className="w-full text-xs border rounded px-1.5 py-1" style={{ borderColor: 'var(--accent)' }}>
          <option value="">— no move —</option>
          {otherClasses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full text-xs border rounded px-1.5 py-1" style={{ borderColor: 'var(--line)' }} />
        <div className="flex gap-1">
          <button onClick={save} className="flex-1 py-0.5 rounded text-xs text-white" style={{ background: 'var(--accent)' }}>Save</button>
          <button onClick={() => setOpen(false)} className="px-2 py-0.5 rounded text-xs border" style={{ borderColor: 'var(--line)' }}>✕</button>
        </div>
      </div>
    );
  }

  if (!student.transitionTo) {
    return (
      <button onClick={openPop} className="text-xs hover:underline italic" style={{ color: 'var(--ink-faint)' }}>— set move</button>
    );
  }
  return (
    <button onClick={openPop} className="inline-flex items-center gap-1 text-xs font-medium hover:underline" style={{ color: '#b45309' }}>
      <ArrowRight size={10} />
      {dest?.name || student.transitionTo}
      {student.transitionDate && <span className="font-mono opacity-70 ml-1">{shortDate(student.transitionDate)}</span>}
    </button>
  );
}

function MoveClassSection({ student, onUpdate }) {
  const { classes } = useClasses();
  const [mode, setMode] = useState(null); // null | 'now' | 'later'
  const [destId, setDestId] = useState('');
  const [date, setDate] = useState('');
  const [newStatus, setNewStatus] = useState('enrolled');

  React.useEffect(() => {
    setMode(null);
    setDestId(student.transitionTo || '');
    setDate(student.transitionDate || '');
    setNewStatus('enrolled');
  }, [student.id]);

  const moveNow = () => {
    if (!destId) return;
    onUpdate({ classId: destId, status: newStatus, transitionTo: null, transitionDate: null });
    setMode(null);
  };
  const saveLater = () => {
    if (!destId) return;
    onUpdate({ transitionTo: destId, transitionDate: date || null });
    setMode(null);
  };
  const cancelTransition = () => {
    onUpdate({ transitionTo: null, transitionDate: null });
    setDestId(''); setDate('');
  };

  const otherClasses = classes.filter(c => c.id !== student.classId);
  const destClass = classes.find(c => c.id === student.transitionTo);

  return (
    <Section title="Move class">
      {/* Pending transition banner */}
      {student.transitionTo && mode === null && (
        <div className="rounded-md p-3 mb-2" style={{ background: 'rgba(180,83,9,0.06)', border: '1px solid rgba(180,83,9,0.2)' }}>
          <div className="text-xs font-medium mb-0.5" style={{ color: '#b45309' }}>
            <ArrowRight size={11} className="inline mr-1" />
            Moving to {destClass?.fullName || student.transitionTo}
          </div>
          {student.transitionDate && <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>On {shortDate(student.transitionDate)}</div>}
          <div className="flex gap-2 mt-2">
            <button onClick={() => { setDestId(student.transitionTo); setDate(student.transitionDate || ''); setMode('later'); }} className="text-xs px-2 py-1 rounded border hover:bg-white transition" style={{ borderColor: 'var(--line)' }}>Edit</button>
            <button onClick={cancelTransition} className="text-xs px-2 py-1 rounded border text-red-600 hover:bg-red-50 transition" style={{ borderColor: 'var(--line)' }}>Cancel move</button>
          </div>
        </div>
      )}

      {/* Action buttons when idle */}
      {mode === null && (
        <div className="flex gap-2">
          <button onClick={() => { setDestId(''); setNewStatus('enrolled'); setMode('now'); }}
            className="flex-1 py-1.5 rounded text-xs font-medium text-white flex items-center justify-center gap-1.5 transition hover:opacity-90"
            style={{ background: 'var(--accent)' }}>
            <ArrowRight size={11} /> Move now
          </button>
          <button onClick={() => { setDestId(student.transitionTo || ''); setDate(student.transitionDate || ''); setMode('later'); }}
            className="flex-1 py-1.5 rounded border text-xs flex items-center justify-center gap-1.5 hover:bg-stone-50 transition"
            style={{ borderColor: 'var(--line)', color: 'var(--ink-soft)' }}>
            <Calendar size={11} /> Schedule move
          </button>
        </div>
      )}

      {/* Move now form */}
      {mode === 'now' && (
        <div className="flex flex-col gap-2">
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--ink-faint)' }}>Move to class</label>
            <select value={destId} onChange={e => setDestId(e.target.value)} autoFocus className="w-full text-xs border rounded px-2 py-1.5" style={{ borderColor: 'var(--line)' }}>
              <option value="">— pick a class —</option>
              {otherClasses.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--ink-faint)' }}>Status after move</label>
            <div className="flex gap-1.5">
              {['enrolled', 'wait_list'].map(s => (
                <button key={s} type="button" onClick={() => setNewStatus(s)}
                  className={`flex-1 py-1.5 rounded text-xs border transition ${newStatus === s ? 'font-semibold' : 'hover:bg-stone-50'}`}
                  style={newStatus === s ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent)' } : { borderColor: 'var(--line)' }}>
                  {s === 'enrolled' ? 'Enrolled' : 'Wait list'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={moveNow} disabled={!destId} className="flex-1 py-1.5 rounded text-xs text-white font-medium disabled:opacity-40" style={{ background: 'var(--accent)' }}>Move now</button>
            <button onClick={() => setMode(null)} className="px-3 py-1.5 rounded text-xs border" style={{ borderColor: 'var(--line)' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Schedule move form */}
      {mode === 'later' && (
        <div className="flex flex-col gap-2">
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--ink-faint)' }}>Moving to</label>
            <select value={destId} onChange={e => setDestId(e.target.value)} autoFocus className="w-full text-xs border rounded px-2 py-1.5" style={{ borderColor: 'var(--line)' }}>
              <option value="">— pick a class —</option>
              {otherClasses.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--ink-faint)' }}>Transition date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full text-xs border rounded px-2 py-1.5" style={{ borderColor: 'var(--line)' }} />
          </div>
          <div className="flex gap-2">
            <button onClick={saveLater} disabled={!destId} className="flex-1 py-1.5 rounded text-xs text-white font-medium disabled:opacity-40" style={{ background: 'var(--accent)' }}>Save</button>
            <button onClick={() => setMode(null)} className="px-3 py-1.5 rounded text-xs border" style={{ borderColor: 'var(--line)' }}>Cancel</button>
          </div>
        </div>
      )}
    </Section>
  );
}

// ============================================================
// STUDENT DETAIL PANEL
// ============================================================

function StudentDetailPanel({ student, onClose, onUpdate, onArchive, onRestore, showToast }) {
  const { classes } = useClasses();
  const [confirmArchive, setConfirmArchive] = useState(false);
  React.useEffect(() => { setConfirmArchive(false); }, [student?.id]);
  if (!student) return null;
  const status = STATUSES[student.status];
  const u = (patch) => onUpdate(student.id, patch);
  return (
    <aside className="w-96 border-l flex flex-col overflow-hidden" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
      <div className="flex items-start justify-between px-5 pt-5 pb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <button onClick={() => u({ gender: student.gender === 'F' ? 'M' : student.gender === 'M' ? 'X' : 'F' })} className="shrink-0" title="click to change">
              <span className="w-2.5 h-2.5 rounded-full block" style={{ background: GENDER[student.gender]?.colour }} />
            </button>
            <div className="font-display text-2xl leading-tight flex-1">
              <EditableCell value={student.name} onSave={v => u({ name: v })} placeholder="Child name" />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full border ${status.chip}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
              {status.label}
            </span>
            <span className="text-xs font-mono" style={{ color: 'var(--ink-faint)' }}>{ageFromDob(student.dob)} · {shortDate(student.dob)}</span>
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>Class:</span>
            <select
              value={student.classId || ''}
              onChange={e => u({ classId: e.target.value || null })}
              className="text-xs font-medium border rounded px-1.5 py-0.5"
              style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
              <option value="">— none —</option>
              {classes.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}
            </select>
          </div>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-stone-100 rounded shrink-0"><X size={16} /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <Section title="Contact">
          <div className="flex items-center gap-2 py-1 text-sm">
            <UserIcon size={12} className="shrink-0" style={{ color: 'var(--ink-faint)' }} />
            <span style={{ color: 'var(--ink-faint)' }}>Gender:</span>
            <div className="flex gap-1">
              {['F', 'M', 'X'].map(g => (
                <button
                  key={g}
                  onClick={() => u({ gender: g })}
                  className={`px-2 py-0.5 rounded-full text-xs border flex items-center gap-1 transition ${student.gender === g ? 'font-semibold' : 'opacity-50 hover:opacity-100'}`}
                  style={{ borderColor: 'var(--line)' }}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: GENDER[g].colour }} />
                  {GENDER[g].label}
                </button>
              ))}
            </div>
          </div>
          <EditableRow icon={UserIcon} label="Parents" value={student.parents} onSave={v => u({ parents: v })} />
          <EditableRow icon={Mail} label="Email" value={student.email} onSave={v => u({ email: v })} multiline />
          <EditableRow icon={Phone} label="Phone" value={student.phone} onSave={v => u({ phone: v })} multiline />
          <EditableRow icon={MapPin} label="Nationality" value={student.nationality} onSave={v => u({ nationality: v })} />
        </Section>
        <Section title="Schedule">
          <div className="flex gap-1 mb-3">
            {['M','T','W','T','F'].map((d, i) => {
              const key = ['mon','tue','wed','thu','fri'][i];
              const v = student[key];
              const cycle = () => u({ [key]: { '': 'F', 'F': 'H', 'H': 'S', 'S': '' }[v || ''] ?? '' });
              return (
                <div key={i} className="flex-1 text-center">
                  <div className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>{d}</div>
                  <button onClick={cycle} className={`h-9 w-full rounded flex items-center justify-center text-sm font-mono font-medium ${v === 'F' ? 'bg-emerald-100 text-emerald-900' : v === 'H' ? 'bg-amber-100 text-amber-900' : v === 'S' ? 'bg-blue-100 text-blue-700' : 'bg-stone-100 text-stone-300'}`}>{v || '·'}</button>
                </div>
              );
            })}
          </div>
          <EditableRow icon={Calendar} label="Started" value={student.originalStart} onSave={v => u({ originalStart: v })} type="date" display={shortDate(student.originalStart)} />
          <EditableRow icon={Calendar} label="Returning" value={student.returningDate} onSave={v => u({ returningDate: v })} type="date" display={student.returningDate ? shortDate(student.returningDate) : ''} />
          <EditableRow icon={Calendar} label="Last day" value={student.lastDate} onSave={v => u({ lastDate: v })} type="date" display={student.lastDate ? shortDate(student.lastDate) : ''} />
          <EditableRow label="Length of stay" value={student.lengthOfStay} onSave={v => u({ lengthOfStay: v })} />
          <div className="flex items-center gap-2 py-1 text-sm">
            <span style={{ color: 'var(--ink-faint)' }}>Lunch:</span>
            <TriStateBox value={student.lunch} onClick={() => u({ lunch: cycleTriState(student.lunch) })} />
          </div>
          <div className="flex items-center gap-2 py-1 text-sm">
            <span style={{ color: 'var(--ink-faint)' }}>Social media:</span>
            <TriStateBox value={student.socialMedia} onClick={() => u({ socialMedia: cycleTriState(student.socialMedia) })} />
          </div>
        </Section>
        <ScheduleChangeSection student={student} onUpdate={u} />
        <SuspensionSection student={student} onUpdate={u} showToast={showToast} />
        <Section title="Billing">
          <EditableRow label="Bond paid" value={student.bondPaid} onSave={v => u({ bondPaid: v })} type="date" display={student.bondPaid ? shortDate(student.bondPaid) : ''} />
          <EditableRow label="Bond returned" value={student.bondReturned} onSave={v => u({ bondReturned: v })} display={student.bondReturned ? shortDate(student.bondReturned) : ''} />
          <EditableRow label="Paid from" value={student.periodFrom} onSave={v => u({ periodFrom: v })} type="date" display={student.periodFrom ? shortDate(student.periodFrom) : ''} />
          <EditableRow label="Paid until" value={student.periodUntil} onSave={v => u({ periodUntil: v })} type="date" display={student.periodUntil ? shortDate(student.periodUntil) : ''} />
          <EditableRow label="Invoice note" value={student.invoiceNote} onSave={v => u({ invoiceNote: v })} />
          {student.prepay && (
            <div className="mt-2 px-3 py-2 rounded-md" style={{ background: 'var(--accent-soft)' }}>
              <div className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--accent)' }}>Prepay block</div>
              <div className="text-sm font-medium">{student.prepay.completed} of {student.prepay.weeks} weeks completed</div>
              <div className="h-1 rounded-full mt-2" style={{ background: 'rgba(60,90,60,0.15)' }}>
                <div className="h-full rounded-full" style={{ width: `${(student.prepay.completed / student.prepay.weeks) * 100}%`, background: 'var(--accent)' }} />
              </div>
              <div className="text-xs mt-1.5" style={{ color: 'var(--ink-faint)' }}>Started {shortDate(student.prepay.startDate)} · {student.prepay.weeks - student.prepay.completed} weeks remaining</div>
            </div>
          )}
        </Section>
        <Section title="Notes">
          <EditableCell value={student.note} onSave={v => u({ note: v })} placeholder="— add a note about this child" />
          {student.dietaryFlags?.length > 0 && (
            <div className="flex gap-1 mt-2 flex-wrap">
              {student.dietaryFlags.map(f => (
                <span key={f} className="text-xs px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">{f.replace('no_', 'no ').replace('_', ' ')}</span>
              ))}
            </div>
          )}
        </Section>

        {/* Inquiry-only details — only show if any are present */}
        {(student.arrivalDate || student.intendedStay || student.daysRequested || student.halfOrFull || student.nativeLanguage || student.formCompletedBy) && (
          <Section title="Enrolment request">
            {student.nativeLanguage && <EditableRow label="Native language" value={student.nativeLanguage} onSave={v => u({ nativeLanguage: v })} />}
            {student.arrivalDate && <EditableRow label="Arrival to Bali" value={student.arrivalDate} onSave={v => u({ arrivalDate: v })} />}
            {student.intendedStay && <EditableRow label="Intended stay" value={student.intendedStay} onSave={v => u({ intendedStay: v })} />}
            {student.daysRequested && <EditableRow label="Days requested" value={student.daysRequested} onSave={v => u({ daysRequested: v })} />}
            {student.halfOrFull && <EditableRow label="Half / full day" value={student.halfOrFull} onSave={v => u({ halfOrFull: v })} />}
            {student.formCompletedBy && <EditableRow label="Form completed by" value={student.formCompletedBy} onSave={v => u({ formCompletedBy: v })} />}
          </Section>
        )}

        {/* Parent details (structured) */}
        {(student.parent1?.name || student.parent1?.email || student.parent1?.phone || student.parent1?.occupation) && (
          <Section title="Parent 1">
            {student.parent1.name && <EditableRow label="Name" value={student.parent1.name} onSave={v => u({ parent1: { ...student.parent1, name: v } })} />}
            {student.parent1.email && <EditableRow icon={Mail} label="Email" value={student.parent1.email} onSave={v => u({ parent1: { ...student.parent1, email: v } })} />}
            {student.parent1.phone && <EditableRow icon={Phone} label="Phone" value={student.parent1.phone} onSave={v => u({ parent1: { ...student.parent1, phone: v } })} />}
            {student.parent1.occupation && <EditableRow label="Occupation" value={student.parent1.occupation} onSave={v => u({ parent1: { ...student.parent1, occupation: v } })} />}
          </Section>
        )}
        {(student.parent2?.name || student.parent2?.email || student.parent2?.phone || student.parent2?.occupation) && (
          <Section title="Parent 2">
            {student.parent2.name && <EditableRow label="Name" value={student.parent2.name} onSave={v => u({ parent2: { ...student.parent2, name: v } })} />}
            {student.parent2.email && <EditableRow icon={Mail} label="Email" value={student.parent2.email} onSave={v => u({ parent2: { ...student.parent2, email: v } })} />}
            {student.parent2.phone && <EditableRow icon={Phone} label="Phone" value={student.parent2.phone} onSave={v => u({ parent2: { ...student.parent2, phone: v } })} />}
            {student.parent2.occupation && <EditableRow label="Occupation" value={student.parent2.occupation} onSave={v => u({ parent2: { ...student.parent2, occupation: v } })} />}
          </Section>
        )}

        {/* Family — siblings/nanny */}
        {(student.siblings?.length > 0 || student.nanny) && (
          <Section title="Family">
            {student.siblings?.length > 0 && (
              <div className="mb-2">
                <div className="text-xs mb-1" style={{ color: 'var(--ink-faint)' }}>Siblings</div>
                {student.siblings.map((s, i) => (
                  <div key={i} className="text-sm py-0.5" style={{ color: 'var(--ink-soft)' }}>
                    {s.name}
                    {s.dob && <span className="text-xs ml-2" style={{ color: 'var(--ink-faint)' }}>· DOB {s.dob}</span>}
                    {s.class && <span className="text-xs ml-2" style={{ color: 'var(--ink-faint)' }}>· {s.class}</span>}
                  </div>
                ))}
              </div>
            )}
            {student.nanny && (
              <div className="mt-2">
                <div className="text-xs mb-1" style={{ color: 'var(--ink-faint)' }}>Pembantu / Nanny</div>
                {student.nanny.name && <div className="text-sm" style={{ color: 'var(--ink-soft)' }}>{student.nanny.name}</div>}
                {student.nanny.phone && <div className="text-xs font-mono" style={{ color: 'var(--ink-faint)' }}>{student.nanny.phone}</div>}
              </div>
            )}
          </Section>
        )}

        {/* Doctor */}
        {student.doctor && (student.doctor.name || student.doctor.contact) && (
          <Section title="Family doctor">
            {student.doctor.name && <EditableRow label="Name" value={student.doctor.name} onSave={v => u({ doctor: { ...student.doctor, name: v } })} />}
            {student.doctor.contact && <EditableRow label="Contact" value={student.doctor.contact} onSave={v => u({ doctor: { ...student.doctor, contact: v } })} />}
          </Section>
        )}

        {/* Medical — only show fields that have data */}
        {(student.vaccinationsYesNo || student.medicalDisabilitiesYesNo || student.medicalProblemsYesNo || student.foodAllergiesYesNo || student.epipen) && (
          <Section title="Medical">
            {student.vaccinationsYesNo && (
              <div className="py-1">
                <div className="text-xs flex justify-between" style={{ color: 'var(--ink-faint)' }}><span>Vaccinations up to date</span><span style={{ color: 'var(--ink-soft)' }}>{student.vaccinationsYesNo}</span></div>
                {student.vaccinationsDetails && <div className="text-xs mt-0.5 whitespace-pre-line" style={{ color: 'var(--ink-soft)' }}>{student.vaccinationsDetails}</div>}
              </div>
            )}
            {student.medicalDisabilitiesYesNo && (
              <div className="py-1">
                <div className="text-xs flex justify-between" style={{ color: 'var(--ink-faint)' }}><span>SEN / disabilities</span><span style={{ color: 'var(--ink-soft)' }}>{student.medicalDisabilitiesYesNo}</span></div>
                {student.medicalDisabilitiesDetails && <div className="text-xs mt-0.5" style={{ color: 'var(--ink-soft)' }}>{student.medicalDisabilitiesDetails}</div>}
              </div>
            )}
            {student.medicalProblemsYesNo && (
              <div className="py-1">
                <div className="text-xs flex justify-between" style={{ color: 'var(--ink-faint)' }}><span>Medical problems / allergies</span><span style={{ color: 'var(--ink-soft)' }}>{student.medicalProblemsYesNo}</span></div>
                {student.medicalProblemsDetails && <div className="text-xs mt-0.5" style={{ color: 'var(--ink-soft)' }}>{student.medicalProblemsDetails}</div>}
              </div>
            )}
            {student.foodAllergiesYesNo && (
              <div className="py-1">
                <div className="text-xs flex justify-between" style={{ color: 'var(--ink-faint)' }}><span>Food allergies</span><span style={{ color: 'var(--ink-soft)' }}>{student.foodAllergiesYesNo}</span></div>
                {student.foodAllergiesDetails && <div className="text-xs mt-0.5" style={{ color: 'var(--ink-soft)' }}>{student.foodAllergiesDetails}</div>}
              </div>
            )}
            {student.epipen && (
              <div className="py-1">
                <div className="text-xs flex justify-between" style={{ color: 'var(--ink-faint)' }}><span>Requires EpiPen</span><span style={{ color: student.epipen.toLowerCase() === 'yes' ? 'var(--terracotta)' : 'var(--ink-soft)', fontWeight: student.epipen.toLowerCase() === 'yes' ? 600 : 400 }}>{student.epipen}</span></div>
              </div>
            )}
          </Section>
        )}

        {/* Old simple siblings list (from class-table data, with class info) — only if not already shown above */}
        {!student.siblings?.[0]?.dob && student.siblings?.length > 0 && false && (
          <Section title="Siblings">
            {student.siblings.map((s, i) => (
              <div key={i} className="text-sm" style={{ color: 'var(--ink-soft)' }}>{s.name} <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>· {s.class}</span></div>
            ))}
          </Section>
        )}

        <MoveClassSection student={student} onUpdate={(patch) => onUpdate(student.id, patch)} />

        <Section title="Change status">
          <div className="grid grid-cols-2 gap-1.5">
            {Object.entries(STATUSES).map(([k, v]) => (
              <button key={k} onClick={() => u({ status: k })} className={`flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md border transition ${student.status === k ? v.chip + ' border-2' : 'hover:bg-stone-50'}`} style={student.status !== k ? { borderColor: 'var(--line)' } : {}}>
                <span className={`w-1.5 h-1.5 rounded-full ${v.dot}`} />
                {v.label}
              </button>
            ))}
          </div>
        </Section>

        <Section title={student.archived ? "Archived" : "Move to archive"}>
          {student.archived ? (
            <>
              <div className="text-xs mb-3" style={{ color: 'var(--ink-faint)' }}>
                This student is in the archive. They won't appear in classes, dashboards, or forecasts, but all their data is preserved.
              </div>
              <button onClick={() => onRestore(student.id)} className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-md border text-emerald-800 hover:bg-emerald-50 transition" style={{ borderColor: 'var(--line)' }}>
                <ArrowRight size={14} /> Restore from archive
              </button>
            </>
          ) : !confirmArchive ? (
            <>
              <div className="text-xs mb-3" style={{ color: 'var(--ink-faint)' }}>
                Archived students are kept forever — their info stays on file for returning families, sibling enrolments, and records. They just don't show up in active views.
              </div>
              <button onClick={() => setConfirmArchive(true)} className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-md border hover:bg-stone-50 transition" style={{ borderColor: 'var(--line)', color: 'var(--ink-soft)' }}>
                <Trash2 size={14} /> Move to archive
              </button>
            </>
          ) : (
            <div className="rounded-md border p-3" style={{ borderColor: 'var(--line)', background: 'var(--paper-2)' }}>
              <div className="text-sm font-medium mb-1">Move {student.name} to archive?</div>
              <div className="text-xs mb-3" style={{ color: 'var(--ink-soft)' }}>They'll be removed from active classes and lists, but all info is preserved and restorable.</div>
              <div className="flex gap-2">
                <button onClick={() => setConfirmArchive(false)} className="flex-1 px-3 py-1.5 text-sm rounded-md border hover:bg-white" style={{ borderColor: 'var(--line)' }}>Cancel</button>
                <button onClick={() => onArchive(student.id)} className="flex-1 px-3 py-1.5 text-sm rounded-md text-white" style={{ background: 'var(--ink)' }}>Move to archive</button>
              </div>
            </div>
          )}
        </Section>
      </div>
    </aside>
  );
}

function EditableRow({ icon: Icon, label, value, onSave, type, display, multiline }) {
  return (
    <div className="flex items-start gap-2 py-1 text-sm">
      {Icon && <Icon size={12} className="mt-1.5 shrink-0" style={{ color: 'var(--ink-faint)' }} />}
      <span className="shrink-0 mt-1" style={{ color: 'var(--ink-faint)' }}>{label}:</span>
      <div className="flex-1 min-w-0">
        <EditableCell value={value} onSave={onSave} type={type} display={display} multiline={multiline} />
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="mt-5 pt-4 border-t first:mt-0 first:pt-0 first:border-0" style={{ borderColor: 'var(--line)' }}>
      <div className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--ink-faint)' }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ icon: Icon, label, value, multiline }) {
  return (
    <div className="flex items-start gap-2 py-1 text-sm">
      {Icon && <Icon size={12} className="mt-1" style={{ color: 'var(--ink-faint)' }} />}
      <span style={{ color: 'var(--ink-faint)' }}>{label}:</span>
      <span style={{ color: 'var(--ink-soft)', whiteSpace: multiline ? 'pre-line' : 'normal' }}>{value || '–'}</span>
    </div>
  );
}

// ============================================================
// EMAIL PARSE MODAL
// ============================================================

function EmailParseModal({ onClose, onConfirm }) {
  const { classes } = useClasses();
  const [emailText, setEmailText] = useState(EXAMPLE_EMAIL);
  const [step, setStep] = useState('paste');
  const [parsed, setParsed] = useState(null);

  const handleParse = () => {
    const r = parseEmail(emailText);
    if (r.childName) r.childName = r.childName.split(' ').map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    setParsed(r);
    setStep('review');
  };

  const updateField = (k, v) => setParsed(p => ({ ...p, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(27,26,23,0.5)' }}>
      <div className="rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" style={{ background: 'var(--paper)' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--line)' }}>
          <div>
            <div className="font-display text-2xl leading-none">New inquiry from email</div>
            <div className="text-xs mt-1" style={{ color: 'var(--ink-faint)' }}>
              {step === 'paste' ? 'Paste the Squarespace enrolment email below' : 'Review the parsed fields and edit any that look wrong'}
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-stone-100 rounded"><X size={18} /></button>
        </div>
        {step === 'paste' && (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <textarea value={emailText} onChange={e => setEmailText(e.target.value)}
                className="w-full h-96 p-4 rounded-md border font-mono text-xs leading-relaxed focus:outline-none focus:ring-2"
                style={{ borderColor: 'var(--line)', background: 'var(--bg)', '--tw-ring-color': 'var(--accent)' }}
                placeholder="Paste email body here…" />
              <div className="mt-3 text-xs flex items-start gap-2" style={{ color: 'var(--ink-faint)' }}>
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <span>The parser handles all 40 fields of the Squarespace form — child details, parents, contact, vaccinations, allergies, siblings, doctor, notes. You'll review everything before saving.</span>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t" style={{ borderColor: 'var(--line)' }}>
              <button onClick={onClose} className="px-4 py-2 text-sm rounded-md hover:bg-stone-100">Cancel</button>
              <button onClick={handleParse} className="px-4 py-2 text-sm rounded-md text-white font-medium" style={{ background: 'var(--accent)' }}>Extract details →</button>
            </div>
          </>
        )}
        {step === 'review' && parsed && (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                <Field label="Child's name" value={parsed.childName} onChange={v => updateField('childName', v)} flag flagText="capitalisation auto-fixed" />
                <Field label="Date of birth" type="date" value={parsed.dob} onChange={v => updateField('dob', v)} />
                <Field label="Nationality" value={parsed.nationality} onChange={v => updateField('nationality', v)} />
                <Field label="Gender" value={parsed.gender} onChange={v => updateField('gender', v)} />
                <Field label="Native language" value={parsed.nativeLanguage} onChange={v => updateField('nativeLanguage', v)} />
                <SelectField label="Requested class" value={parsed.requestedClass} options={classes.map(c => ({ value: c.id, label: c.name }))} onChange={v => updateField('requestedClass', v)} flag flagText={`from "${parsed.requestedClassRaw}"`} />
                <Field label="Preferred start" value={parsed.startDate} onChange={v => updateField('startDate', v)} />
                <Field label="Days requested" value={parsed.days} onChange={v => updateField('days', v)} />
                <Field label="Half / full day" value={parsed.halfFull} onChange={v => updateField('halfFull', v)} />
                <Field label="Length of stay" value={parsed.lengthOfStay} onChange={v => updateField('lengthOfStay', v)} />
                <SectionHead title="Parent 1" />
                <Field label="Name" value={parsed.parent1Name} onChange={v => updateField('parent1Name', v)} />
                <Field label="Email" value={parsed.parent1Email} onChange={v => updateField('parent1Email', v)} />
                <Field label="Phone" value={parsed.parent1Phone} onChange={v => updateField('parent1Phone', v)} />
                <Field label="Occupation" value={parsed.parent1Occupation} onChange={v => updateField('parent1Occupation', v)} />
                <SectionHead title="Parent 2" />
                <Field label="Name" value={parsed.parent2Name} onChange={v => updateField('parent2Name', v)} />
                <Field label="Email" value={parsed.parent2Email} onChange={v => updateField('parent2Email', v)} />
                <Field label="Phone" value={parsed.parent2Phone} onChange={v => updateField('parent2Phone', v)} />
                <Field label="Occupation" value={parsed.parent2Occupation} onChange={v => updateField('parent2Occupation', v)} />
                <SectionHead title="Medical & notes" />
                <Field label="Vaccinations" value={parsed.vaccinations} onChange={v => updateField('vaccinations', v)} />
                <Field label="Food allergies" value={parsed.allergies} onChange={v => updateField('allergies', v)} />
                <Field label="Requires EpiPen" value={parsed.epipen} onChange={v => updateField('epipen', v)} />
                <Field label="Notes from parent" value={parsed.notes} onChange={v => updateField('notes', v)} />
              </div>
            </div>
            <div className="flex justify-between items-center gap-2 px-6 py-4 border-t" style={{ borderColor: 'var(--line)' }}>
              <button onClick={() => setStep('paste')} className="text-sm hover:underline" style={{ color: 'var(--ink-soft)' }}>← Back to email</button>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-4 py-2 text-sm rounded-md hover:bg-stone-100">Cancel</button>
                <button onClick={() => onConfirm(parsed)} className="px-4 py-2 text-sm rounded-md text-white font-medium" style={{ background: 'var(--accent)' }}>Save as inquiry</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, flag, flagText, type = 'text' }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>{label}</label>
      <input type={type} value={value || ''} onChange={e => onChange(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border focus:outline-none focus:ring-2" style={{ borderColor: 'var(--line)', background: 'var(--bg)', '--tw-ring-color': 'var(--accent)' }} />
      {flag && flagText && <div className="text-xs mt-1 italic" style={{ color: 'var(--terracotta)' }}>↑ {flagText}</div>}
    </div>
  );
}

function ReadOnlyField({ label, value, hint }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>{label}</label>
      <div className="w-full px-2.5 py-1.5 text-sm rounded-md border font-mono" style={{ borderColor: 'var(--line)', background: 'var(--line-soft)', color: 'var(--ink-soft)' }}>
        {value || '–'}
      </div>
      {hint && <div className="text-xs mt-1 italic" style={{ color: 'var(--ink-faint)' }}>↑ {hint}</div>}
    </div>
  );
}

function SelectField({ label, value, options, onChange, flag, flagText }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>{label}</label>
      <select value={value || ''} onChange={e => onChange(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border focus:outline-none focus:ring-2" style={{ borderColor: 'var(--line)', background: 'var(--bg)', '--tw-ring-color': 'var(--accent)' }}>
        <option value="">— select —</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {flag && flagText && <div className="text-xs mt-1 italic" style={{ color: 'var(--terracotta)' }}>↑ {flagText}</div>}
    </div>
  );
}

function SectionHead({ title }) {
  return <div className="col-span-2 mt-2 pt-4 border-t" style={{ borderColor: 'var(--line)' }}><div className="font-display text-lg">{title}</div></div>;
}

// ============================================================
// IMPORT MODAL
// ============================================================

// ---- File parser: reads The Garden's xlsx format and extracts student rows ----

const SHEET_CLASS_MAP = {
  'el 1': 'el1', 'el2 daf': 'el2d', 'el2 hib': 'el2h',
  'pk saf': 'pks', 'pk lav': 'pkl', 'jr. kindergarten': 'jrk', 'kindergarten': 'kg',
  // Sanur's workbook abbreviates the last two sheet names to just "JK" / "K" (Canggu's uses the
  // full "Jr. Kindergarten" / "Kindergarten"), which fell through as unrecognised — mapped
  // explicitly here since guessClassFromText's substring checks are too short to catch these safely.
  'jk': 'jrk', 'k': 'kg',
};
const SKIP_SHEETS = ['age calculator', 'total enrolment', 'enrolment forecast', '25+ enrolments'];

function normHeader(s) { return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase(); }

// Canggu's and Sanur's real workbooks are NOT laid out identically: Canggu's occupancy blocks are
// 25 columns wide with no "Social Media" column and Email immediately after Parents Name, while
// Sanur's are 26 columns wide with a Social Media column and Email placed after Holiday
// Suspension. A single hardcoded column-offset formula can only match one centre's layout — the
// previous version was tuned against Sanur's file and silently misaligned every field for Canggu,
// which inflated a real ~155-student June roster into 423 bogus rows (misread garbage columns
// counted as extra "students"). Instead, each field's actual column is found by matching its real
// header label text within the block's own column range, so the map is correct for either layout.
function buildColMapForBlock(rows, blockStart, blockEnd) {
  const row0 = rows[0] || [];
  const row2 = rows[2] || [];
  const find = (row, pred) => {
    for (let c = blockStart; c < blockEnd; c++) { if (pred(normHeader(row[c]))) return c; }
    return -1;
  };
  const fallback = (c, def) => c >= 0 ? c : def;
  return {
    no: fallback(find(row2, v => v === 'no'), blockStart),
    name: fallback(find(row2, v => v === 'child name'), blockStart + 1),
    originalStart: fallback(find(row2, v => v.includes('original start')), blockStart + 2),
    returningDate: fallback(find(row2, v => v.includes('returning date')), blockStart + 3),
    lastDate: fallback(find(row2, v => v.includes('last date')), blockStart + 4),
    dob: fallback(find(row2, v => v === 'dob'), blockStart + 5),
    currentAge: fallback(find(row2, v => v.includes('current age')), blockStart + 6),
    mon: fallback(find(row2, v => v === 'mon'), blockStart + 7),
    tue: fallback(find(row2, v => v === 'tue'), blockStart + 8),
    wed: fallback(find(row2, v => v === 'wed'), blockStart + 9),
    thu: fallback(find(row2, v => v === 'thu'), blockStart + 10),
    fri: fallback(find(row2, v => v === 'fri'), blockStart + 11),
    lunch: fallback(find(row0, v => v === 'lunch'), blockStart + 12),
    nationality: fallback(find(row0, v => v === 'nationality'), blockStart + 13),
    parents: fallback(find(row0, v => v.includes('parents name')), blockStart + 14),
    // Only Sanur's workbook has this column at all (see note above); no fallback offset is given
    // so Canggu's block (which has no such header anywhere in range) correctly resolves to -1
    // instead of a guessed column that would misread some unrelated field as Social Media.
    socialMedia: find(row0, v => v.includes('social media')),
    phone: fallback(find(row0, v => v.includes('phone')), blockStart + 15),
    note: fallback(find(row0, v => v === 'note'), blockStart + 16),
    holidaySuspension: fallback(find(row0, v => v.includes('holiday suspension')), blockStart + 17),
    email: fallback(find(row0, v => v === 'email'), blockStart + 18),
    lengthOfStay: fallback(find(row0, v => v.includes('length of stay')), blockStart + 19),
    bondPaid: fallback(find(row0, v => v.includes('bond') && v.includes('deposit')), blockStart + 20),
    periodFrom: fallback(find(row2, v => v === 'from'), blockStart + 21),
    periodUntil: fallback(find(row2, v => v === 'until'), blockStart + 22),
  };
}

// Every side-by-side occupancy-period block starts at whatever column row1 has "OCCUPANCY
// PERIOD:" — confirmed this is always the exact same column as that block's "No" (row2) and
// class-name (row0) cells, so block boundaries can be found directly by scanning row1 rather than
// assumed from a fixed width that differs between centres.
function findOccupancyBlockStarts(rows) {
  const row1 = rows[1] || [];
  const starts = [];
  for (let c = 0; c < row1.length; c++) {
    if (normHeader(row1[c]).startsWith('occupancy period')) starts.push(c);
  }
  return starts;
}

function findLatestBlock(rows) {
  const MONTHS = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11,jan:0,feb:1,mar:2,apr:3,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const starts = findOccupancyBlockStarts(rows);
  if (starts.length === 0) {
    // No recognisable block headers at all — fall back to a single block starting at column 1
    // (the common case when a sheet has no side-by-side blocks) rather than an empty column map.
    return { COL: buildColMapForBlock(rows, 1, 31), weekMonIso: null };
  }
  const row1 = rows[1] || [];
  const blocks = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : start + 31;
    let period = '';
    for (let c = start; c < end; c++) {
      const v = String(row1[c] || '').trim();
      if (v && /\d/.test(v) && /[a-zA-Z]/.test(v) && !v.toLowerCase().startsWith('occupancy')) { period = v; break; }
    }
    let fri = null;
    const endMatch = period.match(/(\d{1,2})\s+(\w+)\s+(\d{4})\s*$/);
    if (endMatch) {
      const mon = MONTHS[endMatch[2].toLowerCase()];
      if (mon !== undefined) fri = new Date(parseInt(endMatch[3]), mon, parseInt(endMatch[1]));
    }
    return { start, end, fri };
  });

  // Real workbooks are exported several weeks ahead of time (e.g. today's block plus 4 upcoming
  // weeks side by side), so simply picking whichever block has the LATEST date always grabs the
  // furthest-future week instead of the one that's actually relevant right now — importing next
  // month's attendance pattern as if it were today's. Instead: prefer whichever block's Mon–Fri
  // range contains today; if none does (file only covers future or only past weeks), fall back to
  // the nearest upcoming block, and only fall back to the most recent past block if every block
  // in the file is already over.
  const dated = blocks.filter(b => b.fri);
  let chosen = blocks[0];
  if (dated.length > 0) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let containing = null, nearestFuture = null, mostRecentPast = null;
    for (const b of dated) {
      const mon = new Date(b.fri); mon.setDate(mon.getDate() - 4);
      if (mon <= today && today <= b.fri) { containing = b; break; }
      if (b.fri >= today && (!nearestFuture || b.fri < nearestFuture.fri)) nearestFuture = b;
      if (b.fri < today && (!mostRecentPast || b.fri > mostRecentPast.fri)) mostRecentPast = b;
    }
    chosen = containing || nearestFuture || mostRecentPast;
  }
  // The occupancy period always spans a single Mon–Fri working week, and the matched date above is
  // its Friday (the last "d Month yyyy" token in the period text) — so Monday is just 4 days earlier.
  // Used to figure out each weekday column's real calendar date, so blank-but-suspended day cells
  // (see the Holiday Suspension column) can be filled in as 'S' rather than left blank on import.
  let weekMonIso = null;
  if (chosen.fri) {
    const mon = new Date(chosen.fri);
    mon.setDate(mon.getDate() - 4);
    weekMonIso = localIso(mon);
  }
  const COL = buildColMapForBlock(rows, chosen.start, chosen.end);
  return { COL, weekMonIso };
}

function normaliseDay(v) {
  if (!v) return '';
  const s = String(v).trim().toUpperCase();
  if (s === 'F' || s === 'FULL' || s === 'FULL DAY' || s === 'FD' || s === 'Y' || s === 'YES') return 'F';
  if (s === 'H' || s === 'HALF' || s === 'HALF DAY' || s === 'HD' || s === 'AM' || s === 'PM') return 'H';
  return '';
}

// Returns the tri-state value ('yes'/'no'/'') for an imported Excel cell.
function normaliseLunch(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim().toLowerCase();
  if (!s) return '';
  if (['y','yes','true','1','✓','✔','x'].includes(s)) return 'yes';
  if (['n','no','false','0'].includes(s)) return 'no';
  return '';
}

const GIRL_NAMES = new Set(['leila','isabella','kiara','laura','poppy','sahara','sara','maya','nyala','aurora','nina','thea','laia','liepa','astrid','lily','saffira','jasmine','ashley','olivia','renee','vienna','kyla','lyveen','elya','savanna','elif','elara','mikaela','aikanata','araminta','stevie','imogen','sarah','siena','luna','georgina','elsie','ellerie','sofia','cleo','lyla','auri','auraya','kealei','anak','clara','noa']);
const BOY_NAMES = new Set(['luka','thomas','onyx','austin','rafael','soann','sunny','ayaan','kiro','tommy','eren','walt','taj','alexander','tiger','richard','massimo','manuia','pablo','leo','caleb','zeb','sebastian','levi','xydus','leonid','kristian','cassian','harvey','kohaku','asher','elio','atlas','nindyo','remi','lex','adrian','aiden','dean','koa','ignacy','jaxon','nauray','samu','jerome','georgi','kirill','everest','oshyn','arcturus','oliver','kiyoji','apollo','merkur','jacob','toby','wilbur']);

function guessGenderFromName(fullName) {
  if (!fullName) return 'X';
  const first = fullName.trim().split(/\s+/)[0].toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ð/g, 'd');
  if (GIRL_NAMES.has(first)) return 'F';
  if (BOY_NAMES.has(first)) return 'M';
  return 'X';
}

// Full month-name lookup, including long forms (e.g. "july", "january") — the old map
// only had 3-letter keys plus "june", so "8-July-2026" silently failed to parse.
const EXCEL_DATE_MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
  january:0,february:1,march:2,april:3,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };

function excelDateToISO(v) {
  if (!v) return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s.toLowerCase() === 'tbc' || s === '–' || s === '-') return s;
    // Accepts both dash- and space-separated "D Mon YY(YY)", e.g. "30-Aug-25" or "8 Sep 25"
    const m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{2,4})$/);
    if (m) {
      const mon = EXCEL_DATE_MONTHS[m[2].toLowerCase()];
      if (mon !== undefined) {
        let yr = parseInt(m[3]);
        if (yr < 100) yr += yr < 50 ? 2000 : 1900;
        return `${yr}-${String(mon + 1).padStart(2, '0')}-${String(parseInt(m[1])).padStart(2, '0')}`;
      }
    }
    const d = new Date(s + 'T00:00:00');
    if (!isNaN(d) && d.getFullYear() > 1900) {
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    return s;
  }
  if (typeof v === 'number' && v > 1000) {
    const d = new Date((v - 25569) * 86400 * 1000);
    if (!isNaN(d)) {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }
  }
  return String(v);
}

// The source spreadsheet colours a day cell orange/tan and leaves it textless to mark a Holiday
// Suspension day — this is the *only* signal for those cells, so we read the cell's fill colour
// directly (requires XLSX.read to be called with { cellStyles: true }) rather than relying solely
// on parsing the Holiday Suspension note text into date ranges. Confirmed via the real workbooks
// that the two centres use different fill colours here: Canggu's day cells use "FCE5CD" (a light
// tan), while Sanur's day cells use "FFE599" (a stronger gold/orange) — FCE5CD only shows up on
// Sanur's "Holiday suspension List" section-header rows, not on the actual per-day cells, which is
// why Sanur suspensions weren't being detected. Both colours are accepted so this works for either
// centre's file.
const SUSPENSION_FILL_COLORS = new Set(['FCE5CD', 'FFE599']);
function isSuspensionFill(cellStyle) {
  return cellStyle?.patternType === 'solid' && SUSPENSION_FILL_COLORS.has(cellStyle.fgColor?.rgb?.toUpperCase());
}

// The source spreadsheet also colours the "Child Name" cell itself to mark gender — pink
// ("FFCCFF") for girls, blue ("99CCFF") for boys — confirmed consistent across every class
// sheet. This is far more reliable than guessing from a static first-name list, so it's used
// as the primary signal at import time; the name-list guess is kept only as a fallback for
// names whose cell fill isn't one of these two known colours.
function genderFromFill(cellStyle) {
  if (cellStyle?.patternType !== 'solid') return null;
  const rgb = cellStyle.fgColor?.rgb?.toUpperCase();
  if (rgb === 'FFCCFF') return 'F';
  if (rgb === '99CCFF') return 'M';
  return null;
}

function parseSpreadsheetFile(file, centre) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        // cellStyles is required to read each day cell's fill colour, which is how the source
        // spreadsheet marks Holiday Suspension days (tan/brown fill, "FCE5CD") on days that are
        // otherwise left blank — there's no text value in those cells to read any other way.
        const workbook = XLSX.read(data, { type: 'array', cellStyles: true });
        const result = { students: [], warnings: [], sheets: [] };

        for (const sheetName of workbook.SheetNames) {
          const sheetLower = sheetName.trim().toLowerCase();
          if (SKIP_SHEETS.includes(sheetLower)) continue;
          const classId = SHEET_CLASS_MAP[sheetLower];
          if (!classId) {
            const guessed = guessClassFromText(sheetName, centre);
            if (!guessed) { result.warnings.push(`Sheet "${sheetName}": not a recognised class — skipped`); continue; }
          }
          const finalClassId = classId || guessClassFromText(sheetName, centre);
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
          if (rows.length < 4) continue;

          const { COL, weekMonIso } = findLatestBlock(rows);
          const weekDayIsos = weekMonIso
            ? ['mon', 'tue', 'wed', 'thu', 'fri'].map((_, i) => isoAddDays(weekMonIso, i))
            : null;
          let sheetStudentCount = 0;

          // Sections below the main active-student table (WAITLIST, Invoice sent, Quote sent) use the
          // same column layout and carry their own status. `section` tracks which one we're currently in;
          // 'between' means we've passed the active table's totals row but haven't found the next section
          // header yet — rows here are skipped (with a warning) rather than mis-classified as active.
          let section = 'enrolled';
          let blankRunLength = 0;
          for (let ri = 3; ri < rows.length; ri++) {
            const row = rows[ri];
            const childName = String(row[COL.name] || '').trim();
            const col0 = String(row[COL.no] || '').trim().toLowerCase();
            const col1Lower = childName.toLowerCase();
            // Section header text can land anywhere from the "No" column through DOB (merged header cells
            // start at varying columns), so scan that whole window rather than just name/no.
            const headerScan = row.slice(COL.no, COL.dob + 1).map(c => String(c ?? '')).join(' ').toLowerCase();

            // A run of fully blank rows means we've run off the end of the sheet's real content —
            // stop scanning rather than continuing indefinitely toward rows.length. Only look within
            // this block's own columns: sheets stack up to 5 occupancy-period blocks side by side, and
            // a row blank in the current block can still have leftover data in another block's columns,
            // which must not count as "not blank" here. Real sheets have deliberate gaps of 5-7 blank
            // rows between sections (e.g. Invoice sent -> Quote sent), so the threshold must clear that.
            const blockCells = row.slice(COL.no, COL.periodUntil + 1);
            const isBlankRow = blockCells.every(c => String(c ?? '').trim() === '');
            if (isBlankRow) {
              blankRunLength++;
              if (blankRunLength >= 20) break;
              continue;
            }
            blankRunLength = 0;

            // "Recently left" marks the end of anything relevant to current pipeline status — hard-stop
            // the whole sheet scan here (like the old TOTAL-row break) instead of continuing past it,
            // which is what let historical/other-class content leak into this sheet's results.
            if (/recently\s*left/.test(headerScan)) break;

            if (col1Lower.startsWith('total') || col1Lower.includes('holiday suspension') ||
                col1Lower === 'full day' || col1Lower === 'half day' ||
                col0 === 'total' || col0 === 'full day' || col0 === 'half day') { section = 'between'; continue; }
            if (/wait[\s-]?list/.test(headerScan)) { section = 'wait_list'; continue; }
            if (/invoice/.test(headerScan) && /sent|awaiting/.test(headerScan)) { section = 'invoice_sent'; continue; }
            if (/quote/.test(headerScan) && /sent|awaiting/.test(headerScan)) { section = 'quote_sent'; continue; }
            // "Placement Fee" is its own section (families who've paid a placement fee to hold a
            // spot, tracked separately from the main Wait list and from Quote sent). It was
            // previously unrecognised as a section header, so the literal text "Placement Fee" fell
            // through and got imported as a real student named "Placement Fee" carrying whatever
            // status the section above it had. It now gets its own distinct 'placement_fee' status
            // rather than being folded into 'quote_sent' — these families have already paid, they
            // haven't just been quoted.
            if (/placement\s*fee/.test(headerScan)) { section = 'placement_fee'; continue; }
            if (!childName || /^\d+$/.test(childName)) continue;
            if (col1Lower === 'child name' || col1Lower === 'no') continue;
            if (section === 'between') {
              result.warnings.push(`"${childName}" (${sheetName}): row found between sections — couldn't tell which status it belongs to, skipped`);
              continue;
            }

            const nameAddr = XLSX.utils.encode_cell({ r: ri, c: COL.name });
            const student = {
              name: childName,
              gender: genderFromFill(sheet[nameAddr]?.s) || guessGenderFromName(childName),
              classId: finalClassId,
              status: section,
              dob: excelDateToISO(row[COL.dob]),
              nationality: String(row[COL.nationality] || '').trim(),
              parents: String(row[COL.parents] || '').trim(),
              phone: String(row[COL.phone] || '').trim(),
              email: String(row[COL.email] || '').trim(),
              mon: normaliseDay(row[COL.mon]), tue: normaliseDay(row[COL.tue]),
              wed: normaliseDay(row[COL.wed]), thu: normaliseDay(row[COL.thu]),
              fri: normaliseDay(row[COL.fri]),
              lunch: normaliseLunch(row[COL.lunch]),
              socialMedia: COL.socialMedia >= 0 ? normaliseLunch(row[COL.socialMedia]) : '',
              note: String(row[COL.note] || '').trim(),
              holidaySuspension: String(row[COL.holidaySuspension] || '').trim(),
              originalStart: excelDateToISO(row[COL.originalStart]),
              lastDate: excelDateToISO(row[COL.lastDate]),
              lengthOfStay: String(row[COL.lengthOfStay] || '').trim(),
              bondPaid: excelDateToISO(row[COL.bondPaid]),
              periodFrom: excelDateToISO(row[COL.periodFrom]),
              periodUntil: excelDateToISO(row[COL.periodUntil]),
              invoiceNote: '',
              _sheet: sheetName,
            };
            // A blank day cell coloured tan/brown in the source spreadsheet means "gone that day"
            // (Holiday Suspension) — fill those in as 'S' rather than leaving them blank, so the
            // app matches the spreadsheet exactly instead of only inferring suspension via the
            // live week-view overlay. Fill colour (read directly off the cell) is the authoritative
            // signal; the Holiday Suspension note's parsed date range is kept as a fallback for
            // cells whose fill didn't come through for any reason.
            const parsedHs = student.holidaySuspension ? parseHolidaySuspensionNote(student.holidaySuspension) : null;
            const DAY_COLS = { mon: COL.mon, tue: COL.tue, wed: COL.wed, thu: COL.thu, fri: COL.fri };
            ['mon', 'tue', 'wed', 'thu', 'fri'].forEach((day, i) => {
              if (student[day]) return;
              const addr = XLSX.utils.encode_cell({ r: ri, c: DAY_COLS[day] });
              const isBrownFill = isSuspensionFill(sheet[addr]?.s);
              const inParsedRange = weekDayIsos && parsedHs?.ranges.some(r => r.start <= weekDayIsos[i] && r.end >= weekDayIsos[i]);
              if (isBrownFill || inParsedRange) student[day] = 'S';
            });
            if (!student.dob) result.warnings.push(`"${student.name}" (${sheetName}): no date of birth`);
            result.students.push(student);
            sheetStudentCount++;
          }
          if (sheetStudentCount > 0) result.sheets.push({ name: sheetName, count: sheetStudentCount, classId: finalClassId });
        }
        if (result.students.length === 0 && result.warnings.length === 0) {
          result.warnings.push('No student data found. Make sure this is a Garden enrolment spreadsheet.');
        }
        resolve(result);
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

// ---- Import Modal ----

function ImportModal({ onClose, onConfirm, centre }) {
  const { classes } = useClasses();
  const [step, setStep] = useState('upload');
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState(null);
  const [parseResult, setParseResult] = useState(null);
  const [isBackup, setIsBackup] = useState(false);
  const fileInputRef = useRef(null);
  const ACCEPTED_TYPES = '.xlsx,.xls,.csv,.tsv';

  const handleFile = async (f) => {
    if (!f) return;
    setFile(f);
    setParsing(true);
    setParseError(null);
    try {
      // Detect a Garden backup (CSV or the newer per-centre .xlsx export) vs a real school
      // enrolment spreadsheet, which goes through the bespoke parseSpreadsheetFile parser below.
      if (f.name.endsWith('.csv') || f.name.endsWith('.tsv')) {
        const text = await f.text();
        if (isGardenBackupCSV(text)) {
          const students = parseGardenBackupCSV(text);
          if (students.length === 0) {
            setParseError('No students found in the backup file.');
            setParsing(false);
            return;
          }
          setIsBackup(true);
          // Build a result shape compatible with the preview section
          const sheetMap = {};
          students.forEach(s => { sheetMap[s.classId] = (sheetMap[s.classId] || 0) + 1; });
          setParseResult({
            students,
            warnings: [],
            sheets: Object.entries(sheetMap).map(([classId, count]) => ({ name: classId, count, classId })),
          });
          setStep('preview');
          setParsing(false);
          return;
        }
      }
      if (f.name.endsWith('.xlsx') || f.name.endsWith('.xls')) {
        const buf = await f.arrayBuffer();
        const workbook = XLSX.read(buf, { type: 'array' });
        if (isGardenBackupWorkbook(workbook)) {
          const students = parseGardenBackupWorkbook(workbook);
          if (students.length === 0) {
            setParseError('No students found in the backup file.');
            setParsing(false);
            return;
          }
          setIsBackup(true);
          const sheetMap = {};
          students.forEach(s => { sheetMap[s.classId] = (sheetMap[s.classId] || 0) + 1; });
          setParseResult({
            students,
            warnings: [],
            sheets: Object.entries(sheetMap).map(([classId, count]) => ({ name: classId, count, classId })),
          });
          setStep('preview');
          setParsing(false);
          return;
        }
      }
      // Excel / other format
      const result = await parseSpreadsheetFile(f, centre);
      if (result.students.length === 0) {
        setParseError('No student rows found. Make sure this is a Garden enrolment spreadsheet with class sheets like "EL 1", "PK Saf", etc.');
        setParsing(false);
        return;
      }
      setIsBackup(false);
      setParseResult(result);
      setStep('preview');
    } catch (err) { setParseError(`Failed to parse file: ${err.message}`); }
    setParsing(false);
  };

  const handleInputChange = (e) => { handleFile(e.target.files[0]); };
  const handleDrop = (e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); };
  const handleDragOver = (e) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setDragging(false); };
  const fileSizeDisplay = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024*1024 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/(1024*1024)).toFixed(1)} MB`;
  const fileExtension = file ? file.name.split('.').pop().toUpperCase() : '';
  const reset = () => { setFile(null); setParseResult(null); setParseError(null); setStep('upload'); };

  const stats = useMemo(() => {
    if (!parseResult) return null;
    const s = parseResult.students;
    const parentSet = new Set();
    s.forEach(st => { if (st.parents) st.parents.split(/[\/,&]/).forEach(p => { if (p.trim()) parentSet.add(p.trim().toLowerCase()); }); });
    return { total: s.length, parents: parentSet.size, enrolled: s.filter(x => x.status === 'enrolled').length };
  }, [parseResult]);

  const backupCentreLabel = useMemo(() => {
    if (!parseResult) return '';
    const names = [...new Set(parseResult.students.map(s => BACKUP_SHEET_NAMES[s.centre] || s.centre))];
    return names.join(' & ');
  }, [parseResult]);

  const perClass = useMemo(() => {
    if (!parseResult) return [];
    const map = {};
    parseResult.students.forEach(s => { const cid = s.classId || 'unknown'; map[cid] = (map[cid] || 0) + 1; });
    return Object.entries(map).map(([cid, count]) => {
      const cls = classes.find(c => c.id === cid);
      return { id: cid, name: cls?.name || cid, dot: cls?.dot || '#999', count };
    });
  }, [parseResult, classes]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(27,26,23,0.5)' }}>
      <div className="rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col" style={{ background: 'var(--paper)' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--line)' }}>
          <div>
            <div className="font-display text-2xl leading-none">Import students</div>
            <div className="text-xs mt-1" style={{ color: 'var(--ink-faint)' }}>
              {step === 'upload' ? 'Drag a file or click to browse — supports .xlsx, .xls, .csv, .tsv' : `Review ${parseResult?.students.length || 0} students from "${file?.name}"`}
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-stone-100 rounded"><X size={18} /></button>
        </div>
        {step === 'upload' && (
          <>
            <div className="flex-1 px-6 py-8">
              <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES} onChange={handleInputChange} className="hidden" />
              <button onClick={() => fileInputRef.current?.click()} onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave} disabled={parsing}
                className={`w-full border-2 border-dashed rounded-lg py-12 px-6 transition ${dragging ? 'border-emerald-500 bg-emerald-50' : 'hover:bg-stone-50'}`}
                style={!dragging ? { borderColor: 'var(--line)' } : {}}>
                {parsing ? (
                  <><div className="animate-spin w-8 h-8 border-2 border-stone-300 border-t-stone-600 rounded-full mx-auto mb-3" /><div className="font-medium">Parsing {file?.name}…</div></>
                ) : (
                  <><Upload size={32} className="mx-auto mb-3" style={{ color: 'var(--ink-faint)' }} /><div className="font-medium">Drop your file here</div><div className="text-xs mt-1" style={{ color: 'var(--ink-faint)' }}>or click to browse</div></>
                )}
              </button>
              {parseError && (
                <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 flex items-start gap-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />{parseError}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t" style={{ borderColor: 'var(--line)' }}>
              <button onClick={onClose} className="px-4 py-2 text-sm rounded-md hover:bg-stone-100">Cancel</button>
            </div>
          </>
        )}
        {step === 'preview' && parseResult && (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="rounded-md border p-4 mb-4" style={{ borderColor: 'var(--line)', background: 'var(--accent-soft)' }}>
                <div className="text-sm font-medium" style={{ color: 'var(--accent)' }}>
                  {isBackup ? `${backupCentreLabel} backup — ${stats.total} students across ${parseResult.sheets.length} classes` : `Parsed ${stats.total} students from ${parseResult.sheets.length} sheets`}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--ink-soft)' }}>
                  {isBackup ? `This is a ${backupCentreLabel} backup. Restoring will replace all current ${backupCentreLabel} data with this snapshot — the other centre is untouched.` : 'Review the summary below and click Import to commit.'}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 mb-5">
                <Stat label="Students" value={stats.total} />
                <Stat label="Parents" value={stats.parents} />
                <Stat label="Enrolled" value={stats.enrolled} />
              </div>
              <div className="text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--ink-faint)' }}>Per class</div>
              <div className="rounded-md border overflow-hidden" style={{ borderColor: 'var(--line)' }}>
                {perClass.map(c => (
                  <div key={c.id} className="flex items-center justify-between px-3 py-2 border-b last:border-0 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
                    <span className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full" style={{ background: c.dot }} />{c.name}</span>
                    <span className="font-mono text-xs" style={{ color: 'var(--ink-faint)' }}>{c.count} students</span>
                  </div>
                ))}
              </div>
              {parseResult.warnings.length > 0 && (
                <div className="mt-5">
                  <div className="text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--terracotta)' }}>Warnings ({parseResult.warnings.length})</div>
                  <div className="rounded-md border p-3 text-xs space-y-1 max-h-32 overflow-y-auto" style={{ borderColor: 'var(--line)' }}>
                    {parseResult.warnings.map((w, i) => <div key={i} className="flex items-start gap-2"><AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-600" />{w}</div>)}
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-between items-center gap-2 px-6 py-4 border-t" style={{ borderColor: 'var(--line)' }}>
              <button onClick={reset} className="text-sm hover:underline" style={{ color: 'var(--ink-soft)' }}>← Back</button>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-4 py-2 text-sm rounded-md hover:bg-stone-100">Cancel</button>
                <button onClick={() => onConfirm(parseResult.students, isBackup)} className="px-4 py-2 text-sm rounded-md text-white font-medium" style={{ background: 'var(--accent)' }}>
                  {isBackup ? `Restore ${parseResult.students.length} students` : `Import ${parseResult.students.length} students`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-md border px-3 py-2.5" style={{ borderColor: 'var(--line)' }}>
      <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--ink-faint)' }}>{label}</div>
      <div className="font-display text-2xl leading-tight">{value}</div>
    </div>
  );
}

// ============================================================
// DASHBOARD
// ============================================================

function DashboardView({ students, onJump, onExportAll }) {
  const { classes } = useClasses();
  // All counts use isStudentActive() — same logic as sidebar and class header
  const totalEnrolled  = students.filter(s => s.status === 'enrolled' && isStudentActive(s)).length;
  const totalInquiries = students.filter(s => ['inquiry','quote_sent','invoice_sent','placement_fee'].includes(s.status)).length;
  const waitList       = students.filter(s => s.status === 'wait_list').length;
  const suspended      = students.filter(s => ['suspended','extended_holiday'].includes(s.status) && isStudentActive(s)).length;
  const followUps      = students.filter(s => ['quote_sent','invoice_sent'].includes(s.status));
  const prepayExpiring = students.filter(s => s.prepay && (s.prepay.weeks - s.prepay.completed) <= 5);

  return (
    <div className="flex-1 overflow-y-auto px-8 pt-7 pb-16">
      <div className="flex items-center justify-between mb-7">
        <div className="font-display text-4xl">Today, {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <button onClick={onExportAll} className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg border hover:bg-white transition" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
          <Download size={14} /> Export backup
        </button>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <DashStat label="Enrolled" value={totalEnrolled} accent="var(--accent)" />
        <DashStat label="In pipeline" value={totalInquiries} accent="var(--terracotta)" sub="needs follow-up" />
        <DashStat label="Wait list" value={waitList} accent="#7C3AED" />
        <DashStat label="On suspension" value={suspended} accent="#2563EB" />
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="rounded-lg border p-5" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
          <div className="font-display text-2xl mb-3">Needs attention</div>
          {followUps.length === 0 ? (
            <div className="text-sm italic" style={{ color: 'var(--ink-faint)' }}>All caught up.</div>
          ) : followUps.map(f => (
            <div key={f.id} className="py-2.5 border-b last:border-0" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium text-sm">{f.name}</div>
              <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>{STATUSES[f.status]?.label}{f.note ? ` · ${f.note}` : ''}</div>
            </div>
          ))}
        </div>
        <div className="rounded-lg border p-5" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
          <div className="font-display text-2xl mb-3">Prepay expiring</div>
          {prepayExpiring.length === 0 ? (
            <div className="text-sm italic" style={{ color: 'var(--ink-faint)' }}>No prepay blocks ending soon.</div>
          ) : prepayExpiring.map(p => (
            <div key={p.id} className="py-2.5 border-b last:border-0" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="font-medium text-sm">{p.name}</div>
              <div className="text-xs font-mono" style={{ color: 'var(--ink-faint)' }}>{p.prepay.completed}/{p.prepay.weeks} weeks · {p.prepay.weeks - p.prepay.completed} left</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border p-5" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
          <div className="font-display text-xl mb-3">Capacity by class</div>
          {classes.map(c => {
            const n = students.filter(s => s.classId === c.id && ['enrolled','suspended'].includes(s.status) && isStudentActive(s)).length;
            const pct = (n / c.capacity) * 100;
            return (
              <button key={c.id} onClick={() => onJump(c.id)} className="block w-full text-left mb-3 last:mb-0 hover:opacity-80">
                <div className="flex justify-between text-xs mb-1">
                  <span>{c.name}</span>
                  <span className="font-mono" style={{ color: 'var(--ink-faint)' }}>{n}/{c.capacity}</span>
                </div>
                <div className="h-1.5 rounded-full" style={{ background: 'var(--line-soft)' }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(pct,100)}%`, background: pct >= 100 ? 'var(--terracotta)' : pct >= 85 ? '#D97706' : 'var(--accent)' }} />
                </div>
              </button>
            );
          })}
        </div>
        <div className="rounded-lg border p-5" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
          <div className="font-display text-xl mb-3">Suspension alerts</div>
          {students.filter(s => (s.suspensions?.length || 0) >= 3).map(s => (
            <div key={s.id} className="flex items-center justify-between py-2 border-b last:border-0 text-sm" style={{ borderColor: 'var(--line-soft)' }}>
              <span>{s.name}</span>
              <span className={`font-mono text-xs px-2 py-0.5 rounded ${s.suspensions.length >= 4 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}>{s.suspensions.length}/4</span>
            </div>
          ))}
          {students.filter(s => (s.suspensions?.length || 0) >= 3).length === 0 && (
            <div className="text-sm italic" style={{ color: 'var(--ink-faint)' }}>No students at the suspension cap.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function DashStat({ label, value, accent, sub }) {
  return (
    <div className="rounded-lg border p-5" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
      <div className="text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--ink-faint)' }}>{label}</div>
      <div className="font-display text-5xl leading-none" style={{ color: accent }}>{value}</div>
      {sub && <div className="text-xs mt-2" style={{ color: 'var(--ink-faint)' }}>{sub}</div>}
    </div>
  );
}

// ============================================================
// INQUIRIES
// ============================================================

function InquiriesView({ students, onSelectStudent, onParsedConfirm, onUpdate }) {
  const { classes } = useClasses();
  const [emailText, setEmailText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [paneOpen, setPaneOpen] = useState(false);

  const inquiries = students.filter(s => ['inquiry','quote_sent','invoice_sent','wait_list','placement_fee'].includes(s.status));

  const handleParse = () => {
    const r = parseEmail(emailText);
    if (r.childName) r.childName = r.childName.split(' ').map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    setParsed(r);
  };

  const handleApprove = () => {
    onParsedConfirm(parsed);
    setParsed(null);
    setEmailText('');
    setPaneOpen(false);
  };

  const handleReject = () => {
    setParsed(null);
    setEmailText('');
  };

  const updateField = (k, v) => setParsed(p => ({ ...p, [k]: v }));

  // Move inquiry to next status stage
  const advance = (id, currentStatus, target) => {
    const order = { inquiry: 'quote_sent', quote_sent: 'invoice_sent', wait_list: 'enrolled', placement_fee: 'invoice_sent' };
    onUpdate(id, { status: target || order[currentStatus] || currentStatus });
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 pt-7 pb-16">
      <div className="flex items-end justify-between mb-1">
        <div className="font-display text-4xl">Inquiries</div>
        <button onClick={() => setPaneOpen(o => !o)} className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-white transition hover:opacity-90" style={{ background: 'var(--accent)' }}>
          <Plus size={14} /> Paste email
        </button>
      </div>
      <div className="text-sm mb-6" style={{ color: 'var(--ink-soft)' }}>Everyone not yet enrolled, grouped by pipeline stage. Click any name to edit; use the green buttons to move them forward.</div>

      {/* Inline paste-and-parse pane */}
      {paneOpen && (
        <div className="rounded-lg border mb-6 overflow-hidden" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
          <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--line)', background: 'var(--line-soft)' }}>
            <div>
              <div className="font-medium text-sm">{parsed ? 'Review parsed inquiry' : 'Paste the Squarespace enrolment email'}</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--ink-faint)' }}>
                {parsed ? 'Check the extracted fields, edit anything wrong, then approve to add to the pipeline.' : 'The parser handles all 40 fields from the form — child, parents, vaccinations, allergies, siblings, doctor, notes.'}
              </div>
            </div>
            <button onClick={() => { setPaneOpen(false); setParsed(null); setEmailText(''); }} className="p-1 hover:bg-stone-200 rounded"><X size={16} /></button>
          </div>

          {!parsed ? (
            <div className="p-5">
              <textarea
                value={emailText}
                onChange={e => setEmailText(e.target.value)}
                placeholder="Paste the full email body here..."
                className="w-full h-64 p-4 rounded-md border font-mono text-xs leading-relaxed focus:outline-none focus:ring-2"
                style={{ borderColor: 'var(--line)', background: 'var(--bg)', '--tw-ring-color': 'var(--accent)' }}
              />
              <div className="flex justify-between items-center mt-3">
                <button onClick={() => setEmailText(EXAMPLE_EMAIL)} className="text-xs hover:underline" style={{ color: 'var(--ink-faint)' }}>Try a sample email →</button>
                <div className="flex gap-2">
                  <button onClick={() => { setPaneOpen(false); setEmailText(''); }} className="px-3 py-1.5 text-sm rounded-md hover:bg-stone-100">Cancel</button>
                  <button onClick={handleParse} disabled={!emailText.trim()} className="px-4 py-1.5 text-sm rounded-md text-white font-medium disabled:opacity-30" style={{ background: 'var(--accent)' }}>Extract details →</button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="p-5">
                <div className="text-xs uppercase tracking-wider mb-3 flex items-center gap-2" style={{ color: 'var(--ink-faint)' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                  Child
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-w-7xl mb-6">
                  <Field label="Child's name" value={parsed.childName} onChange={v => updateField('childName', v)} flag={parsed.childName !== parsed.childNameRaw} flagText="capitalisation auto-fixed" />
                  <Field label="Date of birth" type="date" value={parsed.dob} onChange={v => updateField('dob', v)} />
                  <ReadOnlyField label="Age" value={ageFromDob(parsed.dob)} hint="calculated from DOB" />
                  <Field label="Gender" value={parsed.gender} onChange={v => updateField('gender', v)} />
                  <Field label="Nationality" value={parsed.nationality} onChange={v => updateField('nationality', v)} />
                  <Field label="Native language" value={parsed.nativeLanguage} onChange={v => updateField('nativeLanguage', v)} />
                  <Field label="Form completed by" value={parsed.formCompletedBy} onChange={v => updateField('formCompletedBy', v)} />
                </div>

                <div className="text-xs uppercase tracking-wider mb-3 flex items-center gap-2" style={{ color: 'var(--ink-faint)' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                  Enrolment request
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-w-7xl mb-6">
                  <Field label="Arrival to Bali" value={parsed.arrivalDate} onChange={v => updateField('arrivalDate', v)} />
                  <Field label="Intended stay" value={parsed.intendedStay} onChange={v => updateField('intendedStay', v)} />
                  <SelectField label="Class" value={parsed.requestedClass} options={classes.map(c => ({ value: c.id, label: c.name }))} onChange={v => updateField('requestedClass', v)} flag={!!parsed.requestedClassRaw} flagText={`from "${parsed.requestedClassRaw}"`} />
                  <Field label="Preferred start" value={parsed.preferredStart} onChange={v => updateField('preferredStart', v)} />
                  <Field label="Days requested" value={parsed.daysRequested} onChange={v => updateField('daysRequested', v)} />
                  <Field label="Half / full day" value={parsed.halfOrFull} onChange={v => updateField('halfOrFull', v)} />
                </div>

                <div className="text-xs uppercase tracking-wider mb-3 flex items-center gap-2" style={{ color: 'var(--ink-faint)' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                  Parent 1
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-w-7xl mb-6">
                  <Field label="Name" value={parsed.parent1Name} onChange={v => updateField('parent1Name', v)} />
                  <Field label="Email" value={parsed.parent1Email} onChange={v => updateField('parent1Email', v)} />
                  <Field label="Phone" value={parsed.parent1Phone} onChange={v => updateField('parent1Phone', v)} />
                  <Field label="Occupation" value={parsed.parent1Occupation} onChange={v => updateField('parent1Occupation', v)} />
                </div>

                <div className="text-xs uppercase tracking-wider mb-3 flex items-center gap-2" style={{ color: 'var(--ink-faint)' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                  Parent 2
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-w-7xl mb-6">
                  <Field label="Name" value={parsed.parent2Name} onChange={v => updateField('parent2Name', v)} />
                  <Field label="Email" value={parsed.parent2Email} onChange={v => updateField('parent2Email', v)} />
                  <Field label="Phone" value={parsed.parent2Phone} onChange={v => updateField('parent2Phone', v)} />
                  <Field label="Occupation" value={parsed.parent2Occupation} onChange={v => updateField('parent2Occupation', v)} />
                </div>

                <div className="text-xs uppercase tracking-wider mb-3 flex items-center gap-2" style={{ color: 'var(--ink-faint)' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                  Siblings
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-w-7xl mb-6">
                  <Field label="Sibling 1 name" value={parsed.sibling1Name} onChange={v => updateField('sibling1Name', v)} />
                  <Field label="Sibling 1 DOB" value={parsed.sibling1Dob} onChange={v => updateField('sibling1Dob', v)} />
                  <Field label="Sibling 2 name" value={parsed.sibling2Name} onChange={v => updateField('sibling2Name', v)} />
                  <Field label="Sibling 2 DOB" value={parsed.sibling2Dob} onChange={v => updateField('sibling2Dob', v)} />
                  <Field label="Sibling 3 name" value={parsed.sibling3Name} onChange={v => updateField('sibling3Name', v)} />
                  <Field label="Sibling 3 DOB" value={parsed.sibling3Dob} onChange={v => updateField('sibling3Dob', v)} />
                </div>

                <div className="text-xs uppercase tracking-wider mb-3 flex items-center gap-2" style={{ color: 'var(--ink-faint)' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                  Carers
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-w-7xl mb-6">
                  <Field label="Pembantu / Nanny name" value={parsed.nannyName} onChange={v => updateField('nannyName', v)} />
                  <Field label="Pembantu / Nanny phone" value={parsed.nannyPhone} onChange={v => updateField('nannyPhone', v)} />
                  <Field label="Family doctor" value={parsed.doctorName} onChange={v => updateField('doctorName', v)} />
                  <Field label="Doctor contact" value={parsed.doctorContact} onChange={v => updateField('doctorContact', v)} />
                </div>

                <div className="text-xs uppercase tracking-wider mb-3 flex items-center gap-2" style={{ color: 'var(--ink-faint)' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                  Medical
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-w-7xl mb-6">
                  <Field label="Vaccinations up to date" value={parsed.vaccinationsYesNo} onChange={v => updateField('vaccinationsYesNo', v)} />
                  <Field label="Vaccination details" value={parsed.vaccinationsDetails} onChange={v => updateField('vaccinationsDetails', v)} />
                  <Field label="Has SEN / disabilities" value={parsed.medicalDisabilitiesYesNo} onChange={v => updateField('medicalDisabilitiesYesNo', v)} />
                  <Field label="SEN / disabilities details" value={parsed.medicalDisabilitiesDetails} onChange={v => updateField('medicalDisabilitiesDetails', v)} />
                  <Field label="Medical problems or allergies" value={parsed.medicalProblemsYesNo} onChange={v => updateField('medicalProblemsYesNo', v)} />
                  <Field label="Medical problems details" value={parsed.medicalProblemsDetails} onChange={v => updateField('medicalProblemsDetails', v)} />
                  <Field label="Food allergies" value={parsed.foodAllergiesYesNo} onChange={v => updateField('foodAllergiesYesNo', v)} />
                  <Field label="Food allergies details" value={parsed.foodAllergiesDetails} onChange={v => updateField('foodAllergiesDetails', v)} />
                  <Field label="Requires EpiPen" value={parsed.epipen} onChange={v => updateField('epipen', v)} />
                </div>

                <div className="text-xs uppercase tracking-wider mb-3 flex items-center gap-2" style={{ color: 'var(--ink-faint)' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                  Other
                </div>
                <div className="max-w-7xl">
                  <Field label="Anything else the parent wants us to know" value={parsed.otherNotes} onChange={v => updateField('otherNotes', v)} />
                </div>
              </div>
              <div className="flex justify-between items-center gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--line)', background: 'var(--line-soft)' }}>
                <button onClick={handleReject} className="text-sm hover:underline" style={{ color: 'var(--ink-soft)' }}>← Back to email</button>
                <div className="flex gap-2">
                  <button onClick={handleReject} className="px-3 py-1.5 text-sm rounded-md hover:bg-stone-200">Discard</button>
                  <button onClick={handleApprove} className="px-4 py-1.5 text-sm rounded-md text-white font-medium flex items-center gap-1.5" style={{ background: 'var(--accent)' }}>
                    <Check size={14} /> Approve & add to pipeline
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Pipeline grouped by status */}
      {['inquiry','quote_sent','invoice_sent','wait_list','placement_fee'].map(st => {
        const list = inquiries.filter(s => s.status === st);
        const status = STATUSES[st];
        const nextLabel = { inquiry: 'Quote sent', quote_sent: 'Invoice sent', wait_list: 'Enrol now', placement_fee: 'Invoice sent' }[st];

        return (
          <div key={st} className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full ${status.dot}`} />
              <span className="font-medium text-sm">{status.label}</span>
              <span className="text-xs font-mono" style={{ color: 'var(--ink-faint)' }}>{list.length}</span>
            </div>
            {list.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-5 text-xs italic" style={{ borderColor: 'var(--line)', color: 'var(--ink-faint)' }}>
                No one in this stage right now.
              </div>
            ) : (
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
                {list.map(s => (
                  <div key={s.id} className="flex items-center justify-between px-4 py-3 border-b last:border-0 hover:bg-stone-50 transition" style={{ borderColor: 'var(--line-soft)' }}>
                    <button onClick={() => onSelectStudent(s.id)} className="flex items-center gap-2 flex-1 text-left">
                      <span className="w-2 h-2 rounded-full" style={{ background: GENDER[s.gender]?.colour }} />
                      <div>
                        <div className="font-medium text-sm">{s.name}</div>
                        <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>{classes.find(c => c.id === s.classId)?.name} · {s.nationality} · {ageFromDob(s.dob)}</div>
                      </div>
                    </button>
                    <div className="text-xs max-w-md mr-4 truncate" style={{ color: 'var(--ink-soft)' }}>{s.note || ''}</div>
                    <div className="flex items-center gap-2 shrink-0">
                      {st === 'invoice_sent' ? (
                        <>
                          <button onClick={() => advance(s.id, s.status, 'enrolled')} className="text-xs px-3 py-1.5 rounded-md text-white font-medium transition hover:opacity-90 flex items-center gap-1" style={{ background: 'var(--accent)' }}>
                            Enrolled <ArrowRight size={11} />
                          </button>
                          <button onClick={() => advance(s.id, s.status, 'wait_list')} className="text-xs px-3 py-1.5 rounded-md font-medium transition hover:opacity-90 flex items-center gap-1 bg-violet-50 text-violet-800 border border-violet-200 hover:bg-violet-100">
                            Wait list <ArrowRight size={11} />
                          </button>
                        </>
                      ) : (
                        <button onClick={() => advance(s.id, s.status)} className="text-xs px-3 py-1.5 rounded-md text-white font-medium transition hover:opacity-90 flex items-center gap-1" style={{ background: 'var(--accent)' }}>
                          {nextLabel} <ArrowRight size={11} />
                        </button>
                      )}
                      <button onClick={() => onSelectStudent(s.id)} className="text-xs px-2 py-1.5 rounded-md border hover:bg-stone-50" style={{ borderColor: 'var(--line)' }}>
                        Edit
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {inquiries.length === 0 && !paneOpen && (
        <div className="rounded-lg border p-12 text-center mt-6" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
          <FileText size={32} className="mx-auto mb-3" style={{ color: 'var(--ink-faint)' }} />
          <div className="font-medium mb-1">No active inquiries</div>
          <div className="text-xs mb-4" style={{ color: 'var(--ink-faint)' }}>When a new enrolment email comes in, paste it above to add the family to the pipeline.</div>
          <button onClick={() => setPaneOpen(true)} className="px-3 py-1.5 rounded-md text-sm font-medium text-white" style={{ background: 'var(--accent)' }}>Paste an email</button>
        </div>
      )}
    </div>
  );
}

function ArchiveView({ students, onSelectStudent, onRestore, onPermanentDelete }) {
  const { classes } = useClasses();
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [filterYear, setFilterYear] = useState('all');

  // Collect years from originalStart for the year filter
  const years = useMemo(() => {
    const ys = new Set();
    students.forEach(s => {
      if (s.originalStart) {
        const y = new Date(s.originalStart).getFullYear();
        if (!isNaN(y)) ys.add(y);
      }
    });
    return Array.from(ys).sort((a, b) => b - a);
  }, [students]);

  const filtered = students.filter(s => {
    if (filterClass !== 'all' && s.classId !== filterClass) return false;
    if (filterYear !== 'all') {
      const y = s.originalStart ? new Date(s.originalStart).getFullYear() : null;
      if (y !== parseInt(filterYear)) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      const matches = s.name.toLowerCase().includes(q) ||
                      s.nationality?.toLowerCase().includes(q) ||
                      s.parents?.toLowerCase().includes(q) ||
                      s.email?.toLowerCase().includes(q);
      if (!matches) return false;
    }
    return true;
  });

  return (
    <div className="flex-1 overflow-y-auto px-8 pt-7 pb-16">
      <div className="flex items-end justify-between mb-1">
        <div className="font-display text-4xl">Archive</div>
        <div className="text-sm font-mono" style={{ color: 'var(--ink-faint)' }}>{filtered.length} of {students.length}</div>
      </div>
      <div className="text-sm mb-6" style={{ color: 'var(--ink-soft)' }}>
        Every family who's ever been through the school. Search by name, parents, email — useful for returning families,
        sibling enrolments, references, and historical records. Click any row to view the full record or restore them.
      </div>

      {students.length === 0 ? (
        <div className="rounded-lg border p-12 text-center" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
          <BookOpen size={32} className="mx-auto mb-3" style={{ color: 'var(--ink-faint)' }} />
          <div className="font-medium mb-1">The archive is empty</div>
          <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>When you move a student to the archive, they'll appear here.</div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-5">
            <div className="relative flex-1 max-w-sm">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--ink-faint)' }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, parents, email…" className="w-full pl-9 pr-3 py-1.5 text-sm rounded-md border focus:outline-none focus:ring-2" style={{ borderColor: 'var(--line)', background: 'var(--paper)', '--tw-ring-color': 'var(--accent)' }} />
            </div>
            <select value={filterClass} onChange={e => setFilterClass(e.target.value)} className="px-3 py-1.5 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
              <option value="all">All classes</option>
              {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={filterYear} onChange={e => setFilterYear(e.target.value)} className="px-3 py-1.5 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
              <option value="all">All years</option>
              {years.map(y => <option key={y} value={y}>Started {y}</option>)}
            </select>
            <button className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border hover:bg-white transition" style={{ borderColor: 'var(--line)' }}>
              <Download size={12} /> Export
            </button>
          </div>

          <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs uppercase tracking-wider" style={{ borderColor: 'var(--line)', background: 'var(--line-soft)', color: 'var(--ink-faint)' }}>
                  <th className="text-left font-medium px-4 py-2.5">Child</th>
                  <th className="text-left font-medium px-3 py-2.5">Last class</th>
                  <th className="text-left font-medium px-3 py-2.5">Parents</th>
                  <th className="text-left font-medium px-3 py-2.5">Start date</th>
                  <th className="text-left font-medium px-3 py-2.5">Last day</th>
                  <th className="text-left font-medium px-3 py-2.5">Reason</th>
                  <th className="text-right font-medium px-3 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => {
                  const cls = classes.find(c => c.id === s.classId);
                  return (
                    <tr key={s.id} className="border-b hover:bg-stone-50 transition" style={{ borderColor: 'var(--line-soft)' }}>
                      <td className="px-4 py-3 cursor-pointer" onClick={() => onSelectStudent(s.id)}>
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: GENDER[s.gender]?.colour }} />
                          <div>
                            <div className="font-medium">{s.name}</div>
                            <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>{s.nationality} · {ageFromDob(s.dob)}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs cursor-pointer" onClick={() => onSelectStudent(s.id)}>
                        <span className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: cls?.dot }} />
                          {cls?.name}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs cursor-pointer" onClick={() => onSelectStudent(s.id)} style={{ color: 'var(--ink-soft)' }}>{s.parents || '–'}</td>
                      <td className="px-3 py-3 text-xs font-mono cursor-pointer" onClick={() => onSelectStudent(s.id)} style={{ color: 'var(--ink-soft)' }}>{shortDate(s.originalStart)}</td>
                      <td className="px-3 py-3 text-xs font-mono cursor-pointer" onClick={() => onSelectStudent(s.id)} style={{ color: 'var(--ink-soft)' }}>{shortDate(s.lastDate) || shortDate(s.archivedAt) || '–'}</td>
                      <td className="px-3 py-3 text-xs cursor-pointer" onClick={() => onSelectStudent(s.id)} style={{ color: 'var(--ink-faint)' }}>{s.note ? s.note.slice(0, 40) + (s.note.length > 40 ? '…' : '') : '–'}</td>
                      <td className="px-3 py-3 text-right">
                        <button onClick={(e) => { e.stopPropagation(); onRestore(s.id); }} className="text-xs px-2.5 py-1 rounded-md border hover:bg-emerald-50 hover:text-emerald-800 transition" style={{ borderColor: 'var(--line)' }}>
                          Restore
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-12 text-center text-sm" style={{ color: 'var(--ink-faint)' }}>No archived students match those filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-4 text-xs" style={{ color: 'var(--ink-faint)' }}>
            <AlertCircle size={11} className="inline mr-1.5" />
            Archived records are kept indefinitely. Permanent deletion is only available to admins under Settings → Data management, in line with privacy regulations (UU PDP).
          </div>
        </>
      )}
    </div>
  );
}

function AllStudentsView({ students, onSelectStudent }) {
  const { classes } = useClasses();
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterClass, setFilterClass] = useState('all');

  const filtered = students.filter(s => {
    if (filterStatus !== 'all' && s.status !== filterStatus) return false;
    if (filterClass !== 'all' && s.classId !== filterClass) return false;
    if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !s.nationality?.toLowerCase().includes(search.toLowerCase()) && !s.parents?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex-1 overflow-y-auto px-8 pt-7 pb-16">
      <div className="flex items-end justify-between mb-1">
        <div className="font-display text-4xl">All students</div>
        <div className="text-sm font-mono" style={{ color: 'var(--ink-faint)' }}>{filtered.length} of {students.length}</div>
      </div>
      <div className="text-sm mb-6" style={{ color: 'var(--ink-soft)' }}>Every student across every class and status. Click any name to view & edit.</div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--ink-faint)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, parents, nationality…" className="w-full pl-9 pr-3 py-1.5 text-sm rounded-md border focus:outline-none focus:ring-2" style={{ borderColor: 'var(--line)', background: 'var(--paper)', '--tw-ring-color': 'var(--accent)' }} />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="px-3 py-1.5 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
          <option value="all">All statuses</option>
          {Object.entries(STATUSES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={filterClass} onChange={e => setFilterClass(e.target.value)} className="px-3 py-1.5 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
          <option value="all">All classes</option>
          {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border hover:bg-white transition" style={{ borderColor: 'var(--line)' }}>
          <Download size={12} /> Export
        </button>
      </div>

      <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wider" style={{ borderColor: 'var(--line)', background: 'var(--line-soft)', color: 'var(--ink-faint)' }}>
              <th className="text-left font-medium px-4 py-2.5">Child</th>
              <th className="text-left font-medium px-3 py-2.5">Class</th>
              <th className="text-left font-medium px-3 py-2.5">Status</th>
              <th className="text-left font-medium px-3 py-2.5">Age</th>
              <th className="text-left font-medium px-3 py-2.5">Parents</th>
              <th className="text-left font-medium px-3 py-2.5">Start date</th>
              <th className="text-center font-medium px-3 py-2.5">HS</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s, i) => {
              const status = STATUSES[s.status];
              const cls = classes.find(c => c.id === s.classId);
              return (
                <tr key={s.id} onClick={() => onSelectStudent(s.id)} className="border-b cursor-pointer hover:bg-stone-50 transition" style={{ borderColor: 'var(--line-soft)' }}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: GENDER[s.gender]?.colour }} />
                      <div>
                        <div className="font-medium">{s.name}</div>
                        <div className="text-xs" style={{ color: 'var(--ink-faint)' }}>{s.nationality}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: cls?.dot }} />
                      {cls?.name}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full border ${status.chip}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                      {status.label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs font-mono" style={{ color: 'var(--ink-soft)' }}>{ageFromDob(s.dob)}</td>
                  <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--ink-soft)' }}>{s.parents || '–'}</td>
                  <td className="px-3 py-2.5 text-xs font-mono" style={{ color: 'var(--ink-soft)' }}>{shortDate(s.originalStart)}</td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`inline-flex items-center justify-center w-7 h-6 rounded text-xs font-mono font-medium ${(s.suspensions?.length || 0) >= 4 ? 'bg-red-100 text-red-700' : (s.suspensions?.length || 0) === 3 ? 'bg-amber-100 text-amber-800' : 'text-stone-500'}`}>
                      {s.suspensions?.length || 0}/4
                    </span>
                  </td>
                  <td className="px-2 py-2.5"><ChevronRight size={14} style={{ color: 'var(--ink-faint)' }} /></td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-12 text-center text-sm" style={{ color: 'var(--ink-faint)' }}>No students match those filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// FORECAST
// ============================================================

// Real projected headcount for one class in one week — a student counts if their Started date is
// on or before that week's Friday and their Last day (if any) is on or after that week's Monday
// (same rule ClassView uses for "active in this week"), attributed to whichever class they'll
// actually be in that week: their normal class, unless a scheduled Transition has already taken
// effect by that week's Friday, in which case they count toward the destination class instead.
function classCountForWeek(students, classId, weekMon, weekFri) {
  return students.filter(s => {
    if (!['enrolled', 'suspended', 'extended_holiday'].includes(s.status)) return false;
    if (isIsoDate(s.originalStart) && weekFri && s.originalStart > weekFri) return false;
    if (isIsoDate(s.lastDate) && weekMon && s.lastDate < weekMon) return false;
    const transitioned = s.transitionTo && isIsoDate(s.transitionDate) && weekFri && s.transitionDate <= weekFri;
    return (transitioned ? s.transitionTo : s.classId) === classId;
  }).length;
}

function ForecastView({ students }) {
  const { classes, updateClass } = useClasses();
  const scrollRef = useRef(null);
  const [editingCell, setEditingCell] = useState(null); // `${classId}:${weekId}`
  const [editValue, setEditValue] = useState('');

  const scrollToWeek = (behavior) => {
    const el = scrollRef.current?.querySelector(`[data-week-idx="${TODAY_WEEK_IDX}"]`);
    el?.scrollIntoView({ behavior, inline: 'center', block: 'nearest' });
  };
  useEffect(() => { scrollToWeek('instant'); }, []);

  const openEdit = (classId, weekId, computed) => {
    const cls = classes.find(c => c.id === classId);
    const existing = cls?.forecastOverrides?.[weekId];
    setEditingCell(`${classId}:${weekId}`);
    setEditValue(existing !== undefined ? String(existing) : String(computed));
  };
  const saveEdit = (classId, weekId, computed) => {
    const cls = classes.find(c => c.id === classId);
    const overrides = { ...(cls?.forecastOverrides || {}) };
    const n = parseInt(editValue, 10);
    if (!isNaN(n) && n >= 0 && n !== computed) overrides[weekId] = n;
    else delete overrides[weekId];
    updateClass(classId, { forecastOverrides: overrides });
    setEditingCell(null);
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 pt-7 pb-16">
      <div className="flex items-center justify-between mb-1">
        <div className="font-display text-4xl">Enrolment forecast</div>
        <button onClick={() => scrollToWeek('smooth')} className="text-xs px-3 py-1.5 rounded-md border hover:bg-white transition" style={{ borderColor: 'var(--line)' }}>Current week</button>
      </div>
      <div className="text-sm mb-6" style={{ color: 'var(--ink-soft)' }}>Projected counts per class · computed from each student's start, last day, and transition dates — click any cell to override, scroll sideways for more weeks</div>

      <div ref={scrollRef} className="rounded-lg border overflow-x-auto" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
        <table className="text-xs" style={{ minWidth: `${170 + WEEKS.length * 72}px` }}>
          <thead>
            <tr className="border-b text-xs uppercase tracking-wider" style={{ borderColor: 'var(--line)', background: 'var(--line-soft)', color: 'var(--ink-faint)' }}>
              <th className="text-left font-medium px-3 py-2.5 sticky-col-header" style={{ left: 0 }}>Class</th>
              <th className="text-center font-medium px-2 py-2.5 sticky-col-header-last" style={{ left: '110px' }}>Cap</th>
              {WEEKS.map((w, wi) => (
                <th key={w.id} data-week-idx={wi} className="text-center font-medium px-2 py-2.5" style={wi === TODAY_WEEK_IDX ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}>
                  <div className="font-mono opacity-60">W{wi + 1}</div>
                  <div className="font-normal whitespace-nowrap">{w.label}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {classes.map(c => (
              <tr key={c.id} className="border-b" style={{ borderColor: 'var(--line-soft)' }}>
                <td className="px-3 py-2 sticky-col font-medium" style={{ left: 0, background: 'var(--paper)' }}>
                  <span className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c.dot }} />
                    {c.name}
                  </span>
                </td>
                <td className="px-2 py-2 text-center font-mono sticky-col-last" style={{ left: '110px', color: 'var(--ink-faint)', background: 'var(--paper)' }}>{c.capacity}</td>
                {WEEKS.map((w, wi) => {
                  const computed = classCountForWeek(students, c.id, w.monDate, w.friDate);
                  const override = c.forecastOverrides?.[w.id];
                  const n = override !== undefined ? override : computed;
                  const pct = (n / c.capacity) * 100;
                  const bg = pct >= 100 ? '#FECACA' : pct >= 85 ? '#FED7AA' : pct >= 60 ? '#D1FAE5' : 'transparent';
                  const cellKey = `${c.id}:${w.id}`;
                  return (
                    <td key={w.id} className="px-1 py-1 text-center font-mono" style={{ background: bg }}>
                      {editingCell === cellKey ? (
                        <input
                          autoFocus type="number" min="0" value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onBlur={() => saveEdit(c.id, w.id, computed)}
                          onKeyDown={e => { if (e.key === 'Enter') saveEdit(c.id, w.id, computed); if (e.key === 'Escape') setEditingCell(null); }}
                          className="w-12 text-center rounded border px-1 py-0.5 text-xs"
                          style={{ borderColor: 'var(--accent)' }}
                        />
                      ) : (
                        <button
                          onClick={() => openEdit(c.id, w.id, computed)}
                          title={override !== undefined ? `Overridden — computed value is ${computed}. Click to change or clear.` : 'Click to override'}
                          className="w-full py-1 hover:underline decoration-dotted">
                          {n}{override !== undefined && <span className="ml-0.5" style={{ color: 'var(--accent)' }}>*</span>}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="font-medium">
              <td className="px-3 py-2 sticky-col" style={{ left: 0, background: 'var(--accent-soft)', color: 'var(--accent)' }}>TOTAL</td>
              <td className="px-2 py-2 text-center font-mono sticky-col-last" style={{ left: '110px', color: 'var(--accent)', background: 'var(--accent-soft)' }}>{classes.reduce((a, c) => a + c.capacity, 0)}</td>
              {WEEKS.map(w => {
                const total = classes.reduce((a, c) => {
                  const computed = classCountForWeek(students, c.id, w.monDate, w.friDate);
                  const override = c.forecastOverrides?.[w.id];
                  return a + (override !== undefined ? override : computed);
                }, 0);
                return <td key={w.id} className="px-2 py-2 text-center font-mono" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{total}</td>;
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center gap-4 text-xs" style={{ color: 'var(--ink-faint)' }}>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: '#D1FAE5' }} /> 60–85% full</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: '#FED7AA' }} /> 85–100% full</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: '#FECACA' }} /> Over capacity</span>
        <span className="flex items-center gap-1.5"><span style={{ color: 'var(--accent)' }}>*</span> manually overridden</span>
      </div>
    </div>
  );
}

// ============================================================
// SETTINGS
// ============================================================

function SettingsView({ onResetData }) {
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState(false);
  const [resetting, setResetting] = useState(false);

  const RESET_PASSWORD = 'thegardenstudents2024';

  const handleReset = async (e) => {
    e.preventDefault();
    if (resetPassword !== RESET_PASSWORD) {
      setResetError(true);
      setResetPassword('');
      return;
    }
    setResetting(true);
    await onResetData();
    setResetOpen(false);
    setResetPassword('');
    setResetting(false);
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 pt-7 pb-16">
      <div className="font-display text-4xl mb-7">Settings</div>
      <div className="space-y-4 max-w-2xl">
        <SettingsCard title="Classes" desc="Add, rename, or change capacity for any class. Changes propagate everywhere." />
        <SettingsCard title="Custom student fields" desc="Add custom fields to the student record (swim ability, preferred nap time, etc.)." />
        <SettingsCard title="Staff & permissions" desc="Manage 34 staff logins. Set role (admin / manager / teacher / accountant) and which centre they can access." />
        <SettingsCard title="Email parser mapping" desc="Customise which Squarespace fields map to which student fields, for when Squarespace adds new questions." />
        <SettingsCard title="Holiday suspension policy" desc="Currently 4 per child per calendar year. Change the cap or add custom rules." />
        <SettingsCard title="Audit log" desc="See who changed what, when. Restore deleted records within 30 days." />
        <SettingsCard title="Status workflow" desc="Add or rename pipeline stages. Default: inquiry → quote → invoice → enrolled / wait list / left." />
        <SettingsCard title="Notifications" desc="Configure automatic alerts (suspension cap, prepay expiring, invoice overdue, etc.)" />

        {/* Reset Data */}
        <div className="rounded-lg border p-5 mt-8" style={{ borderColor: '#FCA5A5', background: '#FFF5F5' }}>
          <div className="font-medium mb-1 text-red-800">Reset Data</div>
          <div className="text-xs mb-4" style={{ color: '#B91C1C' }}>
            Permanently delete all student and class data from the database and restore demo data. This cannot be undone.
          </div>
          <button
            onClick={() => { setResetOpen(true); setResetError(false); setResetPassword(''); }}
            className="text-sm px-4 py-2 rounded-lg font-medium text-white bg-red-600 hover:bg-red-700 transition">
            Remove all data
          </button>
        </div>
      </div>

      {resetOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(27,26,23,0.6)' }}>
          <form onSubmit={handleReset} className="rounded-xl shadow-2xl w-full max-w-sm p-8" style={{ background: 'var(--paper)' }}>
            <div className="text-center mb-5">
              <div className="font-display text-2xl mb-1 text-red-700">Remove all data?</div>
              <div className="text-sm" style={{ color: 'var(--ink-faint)' }}>
                This will permanently delete <strong>every student and class record</strong> from the database across all devices. The demo data will be restored. <strong>This cannot be undone.</strong>
              </div>
            </div>
            <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: 'var(--ink-faint)' }}>Enter admin password to confirm</label>
            <input
              autoFocus
              type="password"
              value={resetPassword}
              onChange={e => { setResetPassword(e.target.value); setResetError(false); }}
              placeholder="Admin password"
              className="w-full px-4 py-3 rounded-lg border text-sm focus:outline-none focus:ring-2 mb-1"
              style={{ borderColor: resetError ? '#dc2626' : 'var(--line)', background: 'var(--bg)', '--tw-ring-color': '#dc2626' }}
            />
            {resetError && <p className="text-xs mb-3 text-red-600">Incorrect password. Data was not deleted.</p>}
            <div className="flex gap-2 mt-4">
              <button type="button" onClick={() => setResetOpen(false)} className="flex-1 py-2.5 rounded-lg border text-sm hover:bg-stone-50 transition" style={{ borderColor: 'var(--line)' }}>
                Cancel
              </button>
              <button type="submit" disabled={resetting} className="flex-1 py-2.5 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition disabled:opacity-50">
                {resetting ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function SettingsCard({ title, desc }) {
  return (
    <button className="block w-full text-left rounded-lg border p-4 hover:bg-stone-50 transition" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
      <div className="font-medium">{title}</div>
      <div className="text-xs mt-1" style={{ color: 'var(--ink-faint)' }}>{desc}</div>
    </button>
  );
}

function AddOrEditClassModal({ existing, onClose, onSave, onDelete }) {
  const [name, setName] = useState(existing?.name || '');
  const [fullName, setFullName] = useState(existing?.fullName || '');
  const [age, setAge] = useState(existing?.age || '');
  const [capacity, setCapacity] = useState(existing?.capacity || 18);
  const [dot, setDot] = useState(existing?.dot || CLASS_COLOURS[0]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const DELETE_CLASS_PASSWORD = 'thegardenstudents2024';

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({ name: name.trim(), fullName: fullName.trim() || name.trim(), age: age.trim(), capacity: parseInt(capacity) || 18, dot });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(27,26,23,0.5)' }}>
      <div className="rounded-xl shadow-2xl w-full max-w-lg flex flex-col" style={{ background: 'var(--paper)' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--line)' }}>
          <div>
            <div className="font-display text-2xl leading-none">{existing ? 'Edit class' : 'Add a new class'}</div>
            <div className="text-xs mt-1" style={{ color: 'var(--ink-faint)' }}>{existing ? 'Rename, change capacity, or pick a different colour.' : 'Create a new class — could be a regular age group, a holiday camp, anything.'}</div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-stone-100 rounded"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Class name</label>
            <input value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="e.g. EL 2 Marigold" className="w-full px-3 py-2 text-sm rounded-md border focus:outline-none focus:ring-2" style={{ borderColor: 'var(--line)', background: 'var(--bg)', '--tw-ring-color': 'var(--accent)' }} />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Full name (optional)</label>
            <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="e.g. Early Learners 2 — Marigold" className="w-full px-3 py-2 text-sm rounded-md border focus:outline-none focus:ring-2" style={{ borderColor: 'var(--line)', background: 'var(--bg)', '--tw-ring-color': 'var(--accent)' }} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Age range</label>
              <input value={age} onChange={e => setAge(e.target.value)} placeholder="e.g. 2–3 yrs" className="w-full px-3 py-2 text-sm rounded-md border focus:outline-none focus:ring-2" style={{ borderColor: 'var(--line)', background: 'var(--bg)', '--tw-ring-color': 'var(--accent)' }} />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Capacity</label>
              <input type="number" min="1" value={capacity} onChange={e => setCapacity(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border focus:outline-none focus:ring-2 font-mono" style={{ borderColor: 'var(--line)', background: 'var(--bg)', '--tw-ring-color': 'var(--accent)' }} />
              <div className="text-xs mt-1 italic" style={{ color: 'var(--ink-faint)' }}>You can exceed this — it's a soft warning only.</div>
            </div>
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--ink-faint)' }}>Colour</label>
            <div className="flex flex-wrap gap-2">
              {CLASS_COLOURS.map(c => (
                <button key={c} onClick={() => setDot(c)} className={`w-7 h-7 rounded-full transition ${dot === c ? 'ring-2 ring-offset-2' : ''}`} style={{ background: c, ringColor: 'var(--ink)' }} />
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-between items-center gap-2 px-6 py-4 border-t" style={{ borderColor: 'var(--line)' }}>
          <div>
            {existing && onDelete && !confirmDelete && (
              <button onClick={() => setConfirmDelete(true)} className="text-xs text-red-700 hover:underline">Delete class</button>
            )}
            {existing && confirmDelete && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-red-700">Enter password to delete:</span>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={e => setDeletePassword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && deletePassword === DELETE_CLASS_PASSWORD) onDelete(); }}
                  autoFocus
                  className="px-2 py-0.5 rounded border text-xs w-32"
                  style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}
                />
                <button onClick={() => { setConfirmDelete(false); setDeletePassword(''); }} className="px-2 py-0.5 rounded border" style={{ borderColor: 'var(--line)' }}>No</button>
                <button
                  onClick={onDelete}
                  disabled={deletePassword !== DELETE_CLASS_PASSWORD}
                  className="px-2 py-0.5 rounded bg-red-600 text-white disabled:opacity-30"
                >
                  Yes, delete
                </button>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded-md hover:bg-stone-100">Cancel</button>
            <button onClick={handleSave} disabled={!name.trim()} className="px-4 py-2 text-sm rounded-md text-white font-medium disabled:opacity-30" style={{ background: 'var(--accent)' }}>{existing ? 'Save changes' : 'Add class'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddStudentModal({ currentClassId, onClose, onSave }) {
  const { classes } = useClasses();
  const [name, setName] = useState('');
  const [gender, setGender] = useState('X');
  const [dob, setDob] = useState('');
  const [nationality, setNationality] = useState('');
  const [classId, setClassId] = useState(currentClassId || classes[0]?.id);
  const [status, setStatus] = useState('enrolled');
  const [parents, setParents] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [originalStart, setOriginalStart] = useState('');
  const [lengthOfStay, setLengthOfStay] = useState('Long term');
  const [note, setNote] = useState('');
  const [days, setDays] = useState({ mon: '', tue: '', wed: '', thu: '', fri: '' });
  const [lunch, setLunch] = useState('');
  const [socialMedia, setSocialMedia] = useState('');

  const cycleDay = (d) => setDays(prev => ({ ...prev, [d]: { '': 'F', 'F': 'H', 'H': 'S', 'S': '' }[prev[d] || ''] ?? '' }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(27,26,23,0.5)' }}>
      <div className="rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col" style={{ background: 'var(--paper)' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--line)' }}>
          <div>
            <div className="font-display text-2xl leading-none">Add student manually</div>
            <div className="text-xs mt-1" style={{ color: 'var(--ink-faint)' }}>For when an email parse isn't available — e.g. a family enrols in person.</div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-stone-100 rounded"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Child's name *</label>
              <input value={name} onChange={e => setName(e.target.value)} autoFocus className="w-full px-3 py-2 text-sm rounded-md border focus:outline-none focus:ring-2" style={{ borderColor: 'var(--line)', background: 'var(--bg)', '--tw-ring-color': 'var(--accent)' }} />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Gender</label>
              <select value={gender} onChange={e => setGender(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}>
                <option value="F">Girl</option>
                <option value="M">Boy</option>
                <option value="X">Not specified</option>
              </select>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Date of birth</label>
              <input type="date" value={dob} onChange={e => setDob(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border font-mono" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }} />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Nationality</label>
              <input value={nationality} onChange={e => setNationality(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }} />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Class</label>
              <select value={classId} onChange={e => setClassId(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}>
                {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}>
                {Object.entries(STATUSES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Started</label>
              <input type="date" value={originalStart} onChange={e => setOriginalStart(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border font-mono" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }} />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Length of stay</label>
              <input value={lengthOfStay} onChange={e => setLengthOfStay(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }} />
            </div>
            <div className="col-span-2">
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Parents</label>
              <input value={parents} onChange={e => setParents(e.target.value)} placeholder="e.g. Anna / Scott" className="w-full px-3 py-2 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }} />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Phone</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border font-mono" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }} />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Email</label>
              <input value={email} onChange={e => setEmail(e.target.value)} className="w-full px-3 py-2 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }} />
            </div>
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--ink-faint)' }}>Attendance pattern (click to cycle F → H → empty)</label>
            <div className="flex gap-2">
              {['mon','tue','wed','thu','fri'].map((d, i) => (
                <div key={d} className="flex-1 text-center">
                  <div className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>{['M','T','W','T','F'][i]}</div>
                  <button onClick={() => cycleDay(d)} className={`w-full h-10 rounded text-sm font-mono font-medium transition ${days[d] === 'F' ? 'bg-emerald-100 text-emerald-900' : days[d] === 'H' ? 'bg-amber-100 text-amber-900' : days[d] === 'S' ? 'bg-blue-100 text-blue-700' : 'bg-stone-100 text-stone-300'}`}>{days[d] || '·'}</button>
                </div>
              ))}
              <div className="flex-1 text-center">
                <div className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Lunch</div>
                <TriStateBox value={lunch} onClick={() => setLunch(cycleTriState(lunch))} className="w-full h-10" iconSize={14} />
              </div>
              <div className="flex-1 text-center">
                <div className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Social media</div>
                <TriStateBox value={socialMedia} onClick={() => setSocialMedia(cycleTriState(socialMedia))} className="w-full h-10" iconSize={14} />
              </div>
            </div>
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--ink-faint)' }}>Note</label>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Allergies, transition info, etc." className="w-full px-3 py-2 text-sm rounded-md border" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }} />
          </div>
        </div>
        <div className="flex justify-end items-center gap-2 px-6 py-4 border-t" style={{ borderColor: 'var(--line)' }}>
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md hover:bg-stone-100">Cancel</button>
          <button onClick={() => onSave({ name, gender, dob, nationality, classId, status, parents, phone, email, originalStart, lengthOfStay, note, ...days, lunch, socialMedia })} disabled={!name.trim()} className="px-4 py-2 text-sm rounded-md text-white font-medium disabled:opacity-30" style={{ background: 'var(--accent)' }}>Add student</button>
        </div>
      </div>
    </div>
  );
}

function NavItem({ icon: Icon, label, active, onClick, badge }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm transition ${active ? 'bg-stone-900 text-white' : 'hover:bg-stone-100'}`} style={!active ? { color: 'var(--ink-soft)' } : {}}>
      <span className="flex items-center gap-2.5">
        <Icon size={15} />
        <span>{label}</span>
      </span>
      {badge && <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: active ? 'rgba(255,255,255,0.2)' : 'var(--terracotta)', color: 'white' }}>{badge}</span>}
    </button>
  );
}

// ============================================================
// PASSWORD GATE
// ============================================================

function CentrePasswordGate({ centre, correctPassword, onSuccess, onClose }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const label = centre === 'canggu' ? 'Canggu' : 'Sanur';

  const submit = (e) => {
    e.preventDefault();
    if (value === correctPassword) { onSuccess(); }
    else { setError(true); setValue(''); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(27,26,23,0.6)' }}>
      <form onSubmit={submit} className="rounded-xl shadow-2xl w-full max-w-sm p-8" style={{ background: 'var(--paper)' }}>
        <div className="text-center mb-6">
          <div className="font-display text-2xl mb-1">{label}</div>
          <div className="text-sm" style={{ color: 'var(--ink-faint)' }}>Enter the {label} centre code to continue</div>
        </div>
        <input
          autoFocus
          type="password"
          value={value}
          onChange={e => { setValue(e.target.value); setError(false); }}
          placeholder="Centre code"
          className="w-full px-4 py-3 rounded-lg border text-sm focus:outline-none focus:ring-2 mb-1"
          style={{ borderColor: error ? '#dc2626' : 'var(--line)', background: 'var(--bg)', '--tw-ring-color': 'var(--accent)' }}
        />
        {error && <p className="text-xs mb-3" style={{ color: '#dc2626' }}>Incorrect code. Try again.</p>}
        <div className="flex gap-2 mt-4">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border text-sm hover:bg-stone-50 transition" style={{ borderColor: 'var(--line)' }}>Cancel</button>
          <button type="submit" className="flex-1 py-2.5 rounded-lg text-sm font-medium text-white transition hover:opacity-90" style={{ background: 'var(--accent)' }}>Unlock</button>
        </div>
      </form>
    </div>
  );
}

const CENTRE_PASSWORDS = { canggu: 'canggu2024', sanur: 'sanur2024' };
const GATE_KEY = 'garden_auth_centre'; // stores 'canggu' or 'sanur'

function PasswordGate() {
  // Session state: null = not logged in, 'canggu'/'sanur' = logged in to that centre
  const [authedCentre, setAuthedCentre] = useState(() => {
    try {
      const saved = localStorage.getItem(GATE_KEY);
      return (saved === 'canggu' || saved === 'sanur') ? saved : null;
    } catch { return null; }
  });

  // Login flow state
  const [selectedCentre, setSelectedCentre] = useState(null); // which centre the user picked
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  if (authedCentre) return <GardenApp initialCentre={authedCentre} />;

  const submit = (e) => {
    e.preventDefault();
    if (value === CENTRE_PASSWORDS[selectedCentre]) {
      try { localStorage.setItem(GATE_KEY, selectedCentre); } catch {}
      setAuthedCentre(selectedCentre);
    } else {
      setError(true);
      setValue('');
    }
  };

  const cardStyle = { width: '100%', maxWidth: 360, background: '#fafaf9', borderRadius: 16, padding: 32, boxShadow: '0 20px 50px rgba(0,0,0,0.4)' };
  const wrapStyle = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1c1917', fontFamily: 'Geist, system-ui, sans-serif', padding: 24 };

  const logo = (
    <div style={{ textAlign: 'center', marginBottom: 24 }}>
      <img src="/favicon.png" alt="The Garden" style={{ width: 56, height: 56, margin: '0 auto 12px', display: 'block', borderRadius: 12 }} onError={(e) => { e.target.style.display = 'none'; }} />
      <h1 style={{ fontFamily: 'Instrument Serif, serif', fontSize: 26, margin: 0, color: '#1c1917' }}>The Garden</h1>
    </div>
  );

  // Step 1: choose centre
  if (!selectedCentre) return (
    <div style={wrapStyle}>
      <style>{FONT_IMPORT}</style>
      <div style={cardStyle}>
        {logo}
        <p style={{ fontSize: 13, color: '#78716c', textAlign: 'center', marginTop: -12, marginBottom: 20 }}>Select your centre to continue</p>
        <div style={{ display: 'flex', gap: 10 }}>
          {['canggu', 'sanur'].map(c => (
            <button key={c} onClick={() => setSelectedCentre(c)} style={{ flex: 1, padding: '14px', borderRadius: 10, border: '1.5px solid #d6d3d1', background: '#fff', fontSize: 15, fontWeight: 500, cursor: 'pointer', color: '#1c1917', textTransform: 'capitalize', transition: 'border-color 0.15s, background 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#3C5A3C'; e.currentTarget.style.background = '#f4f7f4'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#d6d3d1'; e.currentTarget.style.background = '#fff'; }}>
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // Step 2: enter password for chosen centre
  const label = selectedCentre.charAt(0).toUpperCase() + selectedCentre.slice(1);
  return (
    <div style={wrapStyle}>
      <style>{FONT_IMPORT}</style>
      <form onSubmit={submit} style={cardStyle}>
        {logo}
        <p style={{ fontSize: 13, color: '#78716c', textAlign: 'center', marginTop: -12, marginBottom: 20 }}>Enter password for <strong>{label}</strong></p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(false); }}
          placeholder={`${label} password`}
          style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 10, border: `1px solid ${error ? '#dc2626' : '#d6d3d1'}`, fontSize: 15, outline: 'none', background: '#fff' }}
        />
        {error && <p style={{ color: '#dc2626', fontSize: 12, margin: '8px 2px 0' }}>Incorrect password. Try again.</p>}
        <button type="submit" style={{ width: '100%', marginTop: 14, padding: '12px', borderRadius: 10, border: 'none', background: '#1c1917', color: '#fff', fontSize: 15, fontWeight: 500, cursor: 'pointer' }}>
          Enter
        </button>
        <button type="button" onClick={() => { setSelectedCentre(null); setValue(''); setError(false); }}
          style={{ width: '100%', marginTop: 8, padding: '10px', borderRadius: 10, border: '1px solid #d6d3d1', background: 'transparent', color: '#78716c', fontSize: 13, cursor: 'pointer' }}>
          ← Back
        </button>
      </form>
    </div>
  );
}

export default function App() {
  return <PasswordGate />;
}
