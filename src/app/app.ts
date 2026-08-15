import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Component, computed, HostListener, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { GridModule } from '@progress/kendo-angular-grid';

type Status = 'Pagada' | 'Pendiente' | 'Vencida';
type Role = 'admin' | 'client';
type Language = 'en' | 'es';
type InvoiceSortKey = 'poNumber' | 'folio' | 'client' | 'issued' | 'due' | 'amount' | 'status';
type ReconciliationSort = 'date' | 'missing' | 'found';

const LOGIN_COPY = {
  en: {
    brand: 'Billing', portal: 'Client portal', tagline: 'Simple. Secure. Always available.',
    headline1: 'Your invoices,', headline2: 'always within reach.',
    description: 'View, organize, and download your documents from one place, wherever you are.',
    secure: 'Secure connection', available: 'Available 24/7', welcome: 'Welcome back',
    title: 'Account Access',
    subtitle: 'Sign in to review and manage your invoices.',
    password: 'Password',
    login: 'Continue',
    error: 'Incorrect username or password',
    admin: 'Administrator',
    client: 'Client',
    logout: 'Sign out',
    balance: 'Balance',
    syncCredits: 'Sync Credits',
    usernamePlaceholder: 'you@email.com',
    show: 'Show', hide: 'Hide', submit: 'Sign in to my account', demo: 'Client demo access',
    protected: 'Your data is protected and encrypted.', connectionError: 'Unable to connect to the server.',
    adminPanel: 'Admin dashboard', myAccount: 'My account', clientPortalTitle: 'Client Portal', clientPortalSubtitle: 'View your invoices and receiving documents',
    manageTitle: 'Invoice management', myInvoices: 'My invoices', manageSubtitle: 'Manage and track your clients’ invoices.',
    clientSubtitle: 'View the status and details of all your documents.', newInvoice: 'New invoice', totalBilling: 'Total billing',
    registeredInvoices: 'invoices registered', paid: 'Paid', completedPayments: 'Completed payments', outstanding: 'Outstanding',
    followUp: 'Requires follow-up', searchPlaceholder: 'Search by number, client, or description', all: 'All', allStatuses: 'All', allCustomers: 'All customers', dateRange: 'Date range', receivingFilter: 'Receiving', withReceiving: 'With receiving', withoutReceiving: 'Without receiving', pending: 'Pending', overdue: 'Overdue', received: 'Received',
    invoice: 'Invoice', customer: 'Customer', issued: 'Issued', due: 'Due date', amount: 'Amount', status: 'Status', action: 'Action',
    reconciliation: 'Reconciliation', uploadExcel: 'Upload Excel', systemInvoices: 'Invoices in system', excelInvoices: 'Invoices in ContPAQ', filterByDate: 'Filter by date', refresh: 'Refresh', folioLabel: 'Invoice', seriesPo: 'Series / PO', dateLabel: 'Date', resultLabel: 'Result', foundResult: 'Found', missingResult: 'Missing', readingExcel: 'Reading Excel…', noReconciliation: 'No invoices to reconcile.',
    viewDetails: 'View details', viewInvoice: 'Invoice PDF', viewReceiving: 'Receiving', uploadReceiving: 'Upload receiving', noResults: 'No invoices match these filters.', systemFooter: 'Invoice management and client portal',
    invoiceData: 'Invoice information', invoiceNumber: 'Invoice No.', poNumber: 'PO Number', invoicePdf: 'Invoice PDF', receivingPdf: 'Receiving PDF', readingPdf: 'Reading invoice PDF...', customerName: 'Customer name *', email: 'Email address', concept: 'Description *',
    issueDate: 'Issue date', dueDate: 'Due date', amountUsd: 'Amount (USD)', cancel: 'Cancel', createInvoice: 'Create invoice',
    invoiceDetails: 'Invoice details', billedTo: 'Billed to', descriptionLabel: 'Description', subtotal: 'Subtotal', tax: 'Tax (16%)',
    totalLabel: 'Total', invoiceStatus: 'Invoice status', thankYou: 'Thank you for your business.', documentNotice: 'This document is an invoice representation for reference purposes.',
    delete: 'Delete', of: 'of', itemsPerPage: 'items per page', markPaid: 'Mark as paid', printPdf: 'Print / PDF', createdSuccess: 'Invoice created successfully',
    paidSuccess: 'The invoice was marked as paid', deletedSuccess: 'Invoice deleted', deleteConfirm: 'Delete invoice',
    clientManagement: 'Client management', clientManagementSubtitle: 'Create accounts and control access to the portal.',
    newClient: 'New client', activeClients: 'Active clients', inactiveClients: 'Inactive clients', usernameLabel: 'Username', access: 'Access',
    active: 'Active', inactive: 'Inactive', edit: 'Edit', clientData: 'Client account', fullName: 'Full name *', passwordNew: 'Password *',
    passwordEdit: 'New password (leave blank to keep current)', passwordHint: 'Minimum 8 characters', saveChanges: 'Save changes', createClient: 'Create client',
    clientCreated: 'Client account created', clientUpdated: 'Client account updated', clientDeleted: 'Client deleted', noClients: 'No client accounts found.',
    deactivate: 'Deactivate', activate: 'Activate', deleteClientConfirm: 'Delete client', accountCredentials: 'For another contact, use the same client name and a different email.', clientAccount: 'Client account',
    companyName: 'PACIFICA FARMS', loginDescription: 'Your solution for viewing invoices and tracking payments.', emailLabel: 'Email *', continueLabel: 'Continue', signInLabel: 'Sign in', loginWithLabel: 'Login With Pacifica', joinUs: 'Join Us', joinConnect: 'Join Connect', forgotPassword: 'Forgot Password?',
    invoicesTab: 'Invoices', clientsTab: 'Clients'
  },
  es: {
    brand: 'Facturación', portal: 'Portal de clientes', tagline: 'Simple. Seguro. Siempre disponible.',
    headline1: 'Tus facturas,', headline2: 'siempre a la mano.',
    description: 'Consulta, organiza y descarga tus comprobantes desde un solo lugar, estés donde estés.',
    secure: 'Conexión segura', available: 'Disponible 24/7', welcome: 'Bienvenido de nuevo',
    title: 'Acceso a tu cuenta',
    subtitle: 'Inicia sesión para revisar y gestionar tus facturas.',
    password: 'Contraseña',
    login: 'Continuar',
    error: 'Usuario o contraseña incorrectos',
    admin: 'Administrador',
    client: 'Cliente',
    logout: 'Cerrar sesión',
    balance: 'Saldo',
    syncCredits: 'Sincronizar Créditos',
    username: 'Usuario o correo', usernamePlaceholder: 'tu@correo.com',
    show: 'Ver', hide: 'Ocultar', submit: 'Ingresar a mi cuenta', demo: 'Acceso de demostración para cliente',
    protected: 'Tus datos se encuentran protegidos y cifrados.', connectionError: 'No fue posible conectar con el servidor.',
    adminPanel: 'Panel administrativo', myAccount: 'Mi cuenta', clientPortalTitle: 'Portal de clientes', clientPortalSubtitle: 'Consulta tus facturas y documentos de recibimiento',
    manageTitle: 'Gestión de facturas', myInvoices: 'Mis facturas', manageSubtitle: 'Administra y da seguimiento a la facturación de tus clientes.',
    clientSubtitle: 'Consulta el estado y detalle de todos tus comprobantes.', newInvoice: 'Nueva factura', totalBilling: 'Facturación total',
    registeredInvoices: 'facturas registradas', paid: 'Pagado', completedPayments: 'Cobros completados', outstanding: 'Por cobrar',
    followUp: 'Requiere seguimiento', searchPlaceholder: 'Buscar por folio, cliente o concepto', all: 'Todas', allStatuses: 'Todos', allCustomers: 'Todos los clientes', dateRange: 'Rango de fechas', receivingFilter: 'Recibimiento', withReceiving: 'Con recibimiento', withoutReceiving: 'Sin recibimiento', pending: 'Pendiente', overdue: 'Vencida', received: 'Recibido',
    invoice: 'Factura', customer: 'Cliente', issued: 'Emisión', due: 'Vencimiento', amount: 'Importe', status: 'Estado', action: 'Acción',
    viewDetails: 'Ver detalle', viewInvoice: 'PDF de factura', viewReceiving: 'Recibimiento', uploadReceiving: 'Subir recibimiento', noResults: 'No encontramos facturas con esos filtros.', systemFooter: 'Sistema de consulta y administración',
    invoiceData: 'Datos del comprobante', invoiceNumber: 'Número de factura', poNumber: 'Número PO', invoicePdf: 'PDF de factura', receivingPdf: 'PDF de recibimiento', readingPdf: 'Leyendo PDF de factura...', customerName: 'Nombre del cliente *', email: 'Correo electrónico', concept: 'Concepto *',
    issueDate: 'Fecha de emisión', dueDate: 'Fecha de vencimiento', amountUsd: 'Importe (USD)', cancel: 'Cancelar', createInvoice: 'Crear factura',
    invoiceDetails: 'Detalle de factura', billedTo: 'Facturado a', descriptionLabel: 'Descripción', subtotal: 'Subtotal', tax: 'IVA (16%)',
    totalLabel: 'Total', invoiceStatus: 'Estado de la factura', thankYou: 'Gracias por su preferencia.', documentNotice: 'Este documento es una representación del comprobante para fines de consulta.',
    delete: 'Eliminar', of: 'de', itemsPerPage: 'elementos por página', markPaid: 'Marcar pagada', printPdf: 'Imprimir / PDF', createdSuccess: 'Factura creada correctamente',
    paidSuccess: 'La factura se marcó como pagada', deletedSuccess: 'Factura eliminada', deleteConfirm: 'Eliminar la factura',
    invoicesTab: 'Facturas', clientsTab: 'Clientes', clientManagement: 'Gestión de clientes', clientManagementSubtitle: 'Crea cuentas y controla el acceso al portal.',
    newClient: 'Nuevo cliente', activeClients: 'Clientes activos', inactiveClients: 'Clientes inactivos', usernameLabel: 'Usuario', access: 'Acceso',
    active: 'Activo', inactive: 'Inactivo', edit: 'Editar', clientData: 'Cuenta del cliente', fullName: 'Nombre completo *', passwordNew: 'Contraseña *',
    passwordEdit: 'Nueva contraseña (vacío conserva la actual)', passwordHint: 'Mínimo 8 caracteres', saveChanges: 'Guardar cambios', createClient: 'Crear cliente',
    clientCreated: 'Cuenta de cliente creada', clientUpdated: 'Cuenta de cliente actualizada', clientDeleted: 'Cliente eliminado', noClients: 'No hay cuentas de clientes.',
    deactivate: 'Desactivar', activate: 'Activar', deleteClientConfirm: 'Eliminar al cliente', accountCredentials: 'Para agregar otro contacto, usa el mismo nombre del cliente y un correo diferente.', clientAccount: 'Cuenta de cliente',
    reconciliation: 'Conciliación', uploadExcel: 'Subir Excel', systemInvoices: 'Facturas en el sistema', excelInvoices: 'Facturas en ContPAQ', filterByDate: 'Filtrar por fecha', refresh: 'Actualizar', folioLabel: 'Factura', seriesPo: 'Serie / PO', dateLabel: 'Fecha', resultLabel: 'Resultado', foundResult: 'Encontrada', missingResult: 'Faltante', readingExcel: 'Leyendo Excel…', noReconciliation: 'No hay facturas para conciliar.',
    companyName: 'PACIFICA FARMS', loginDescription: 'Tu solución para consultar tus facturas y dar seguimiento a tus pagos.', emailLabel: 'Correo electrónico *', continueLabel: 'Continuar', signInLabel: 'Ingresar', loginWithLabel: 'Ingresar a Pacifica', joinUs: 'Crear cuenta', joinConnect: 'Conectar', forgotPassword: '¿Olvidaste tu contraseña?'
  }
} as const;

interface Invoice {
  id: number;
  folio: string;
  client: string;
  location?: string;
  clientKey?: string;
  email: string;
  concept: string;
  issued: string;
  due: string;
  amount: number;
  status: Status;
  poNumber?: string;
  invoiceFileName?: string;
  receivingFileName?: string;
  invoiceSharePointUrl?: string;
  receivingSharePointUrl?: string;
  creditAmount?: number;
  credits?: { creditNumber: string, amount: number, dateProcessed: string, creditPdfPath: string, creditSharePointUrl: string }[];
}

interface ReconciliationRow {
  folio: string;
  series: string;
  client: string;
  date: string;
  total: number;
  inContPaq: boolean;
  inSystem: boolean;
  sourceStatus: 'both' | 'contpaq' | 'system';
  existsInSystem: boolean;
  systemInvoiceId: number | null;
}

interface ReconciliationResponse {
  source: string;
  rows: ReconciliationRow[];
  totals: { excel: number; found: number; missing: number };
}

interface ClientUser {
  id: number;
  name: string;
  username: string;
  email: string;
  clientKey?: string;
  role: 'client';
  active: boolean;
  createdAt?: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatIconModule, MatMenuModule, MatSelectModule, GridModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  private readonly http = inject(HttpClient);
  loginUser = '';
  language = signal<Language>((localStorage.getItem('fc-language') as Language) || 'en');
  loginPassword = '';
  loginStep = signal<'email' | 'password'>('email');
  loginError = signal('');
  showPassword = signal(false);
  user = signal<{ name: string; role: Role; email?: string; clientKey?: string } | null>(null);
  search = signal('');
  statusFilter = signal<'all' | 'withReceiving' | 'withoutReceiving'>('all');
  customerFilter = signal('all');
  dateFrom = signal('');
  dateTo = signal('');
  invoicePage = signal(1);
  invoicePageSize = signal(10);
  invoiceSortKey = signal<InvoiceSortKey>('issued');
  invoiceSortDirection = signal<'asc' | 'desc'>('desc');
  showForm = signal(false);
  activeTab = signal<'invoices' | 'clients'>('invoices');
  reconciliationView = signal(new URLSearchParams(window.location.search).get('view') === 'reconciliation');
  reconciliationRows = signal<ReconciliationRow[]>([]);
  reconciliationTotals = signal({ excel: 0, found: 0, missing: 0 });
  reconciliationSource = signal('');
  reconciliationLoading = signal(false);
  reconciliationDateFrom = signal('');
  reconciliationDateTo = signal('');
  reconciliationSort = signal<ReconciliationSort>('date');
  clients = signal<ClientUser[]>([]);
  showClientForm = signal(false);
  editingClient = signal<ClientUser | null>(null);
  clientForm = { name: '', username: '', email: '', password: '' };
  selected = signal<Invoice | null>(null);
  invoiceActionTarget = signal<Invoice | null>(null);
  invoiceActionMenuPosition = signal({ top: 0, left: 0 });
  showEditInvoiceForm = signal(false);
  editingInvoice = signal<Invoice | null>(null);
  editInvoiceForm = this.emptyEditInvoice();
  menuOpen = signal(false);
  toast = signal('');
  loading = signal(false);
  pdfReading = signal(false);
  pdfError = signal('');
  invoicePdfFile: File | null = null;
  receivingPdfFile: File | null = null;
  newInvoice = this.emptyInvoice();

  @HostListener('document:click', ['$event'])
  closeAccountMenuOnOutsideClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.portal-account-menu-anchor')) this.menuOpen.set(false);
    if (!target?.closest('.portal-invoice-actions-menu') && !target?.closest('.portal-invoice-actions-menu-button')) this.invoiceActionTarget.set(null);
    const actionButton = target?.closest('.portal-invoice-actions-menu-button') as HTMLElement | null;
    if (actionButton && this.invoiceActionTarget()) {
      const rect = actionButton.getBoundingClientRect();
      this.invoiceActionMenuPosition.set({ top: rect.bottom + 6, left: Math.max(12, rect.right - 248) });
    }
  }

  invoices = signal<Invoice[]>([]);

  customerOptions = computed(() => Array.from(new Set(this.invoices().map(invoice => invoice.client).filter(Boolean))).sort((a, b) => a.localeCompare(b)));

  filteredInvoices = computed(() => {
    const current = this.user();
    const query = this.search().trim().toLowerCase();
    return this.invoices().filter(invoice => {
      const allowed = current?.role === 'admin' || (!!current?.clientKey && invoice.clientKey === current.clientKey) || invoice.email === current?.email;
      const receiving = this.statusFilter() === 'all'
        || (this.statusFilter() === 'withReceiving' && !!invoice.receivingSharePointUrl)
        || (this.statusFilter() === 'withoutReceiving' && !invoice.receivingSharePointUrl);
      const customer = this.customerFilter() === 'all' || invoice.client === this.customerFilter();
      const from = !this.dateFrom() || invoice.issued >= this.dateFrom();
      const to = !this.dateTo() || invoice.issued <= this.dateTo();
      const text = `${invoice.folio} ${invoice.poNumber || ''} ${invoice.client} ${invoice.concept} ${invoice.amount}`.toLowerCase();
      return allowed && receiving && customer && from && to && (!query || text.includes(query));
    }).sort((a, b) => {
      const key = this.invoiceSortKey();
      const direction = this.invoiceSortDirection() === 'asc' ? 1 : -1;
      if (key === 'amount') return (a.amount - b.amount) * direction;
      return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true, sensitivity: 'base' }) * direction;
    });
  });

  visibleInvoices = computed(() => {
    const start = (this.invoicePage() - 1) * this.invoicePageSize();
    return this.filteredInvoices().slice(start, start + this.invoicePageSize());
  });

  invoiceTotalPages = computed(() => Math.max(1, Math.ceil(this.filteredInvoices().length / this.invoicePageSize())));
  invoicePageNumbers = computed(() => {
    const total = this.invoiceTotalPages();
    if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
    const current = Math.min(this.invoicePage(), total);
    let start = Math.max(1, current - 3);
    const end = Math.min(total, start + 6);
    if (end - start < 6) start = end - 6;
    return Array.from({ length: 7 }, (_, index) => start + index);
  });

  total = computed(() => this.filteredInvoices().reduce((sum, item) => sum + item.amount, 0));
  pending = computed(() => this.filteredInvoices().filter(item => item.status !== 'Pagada').reduce((sum, item) => sum + item.amount, 0));
  paid = computed(() => this.filteredInvoices().filter(item => item.status === 'Pagada').reduce((sum, item) => sum + item.amount, 0));
  filteredReconciliationRows = computed(() => {
    const query = this.search().trim().toLowerCase();
    const rows = this.reconciliationRows().filter(row => {
      const from = !this.reconciliationDateFrom() || row.date >= this.reconciliationDateFrom();
      const to = !this.reconciliationDateTo() || row.date <= this.reconciliationDateTo();
      const text = `${row.folio} ${row.series || ''} ${row.client} ${row.total}`.toLowerCase();
      return from && to && (!query || text.includes(query));
    });
    const sort = this.reconciliationSort();
    return [...rows].sort((a, b) => {
      if (sort === 'missing' || sort === 'found') {
        const aIsBoth = a.sourceStatus === 'both';
        const bIsBoth = b.sourceStatus === 'both';
        if (aIsBoth !== bIsBoth) {
          if (sort === 'missing') return aIsBoth ? 1 : -1;
          return aIsBoth ? -1 : 1;
        }
      }

      const dateOrder = b.date.localeCompare(a.date);
      if (dateOrder !== 0) return dateOrder;
      return a.folio.localeCompare(b.folio, undefined, { numeric: true });
    });
  });
  reconciliationExcelTotal = computed(() => this.filteredReconciliationRows().filter(row => row.inContPaq).length);
  reconciliationSystemTotal = computed(() => this.filteredReconciliationRows().filter(row => row.inSystem).length);

  reconciliationResultLabel(row: ReconciliationRow) {
    if (row.sourceStatus === 'both') return this.language() === 'es' ? 'Ambas' : 'Both';
    if (row.sourceStatus === 'system') return this.language() === 'es' ? 'Solo sistema' : 'System only';
    return this.language() === 'es' ? 'Solo ContPAQ' : 'ContPAQ only';
  }


  setInvoicePage(page: number) {
    this.invoicePage.set(Math.min(Math.max(1, page), this.invoiceTotalPages()));
  }

  setInvoicePageSize(value: string) {
    this.invoicePageSize.set(Number(value));
    this.invoicePage.set(1);
  }

  sortInvoices(key: InvoiceSortKey) {
    if (this.invoiceSortKey() === key) {
      this.invoiceSortDirection.set(this.invoiceSortDirection() === 'asc' ? 'desc' : 'asc');
    } else {
      this.invoiceSortKey.set(key);
      this.invoiceSortDirection.set(key === 'issued' ? 'desc' : 'asc');
    }
    this.invoicePage.set(1);
    const table = document.querySelector('.portal-table');
    table?.setAttribute('data-sort-key', key);
    table?.setAttribute('data-sort-direction', this.invoiceSortDirection());
  }

  @HostListener('document:click', ['$event'])
  sortInvoiceFromHeader(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    const header = target?.closest('.portal-table thead th') as HTMLTableCellElement | null;
    const table = header?.closest('.portal-table');
    if (!header || !table || table.querySelectorAll('thead th').length < 8 || header.cellIndex >= 7) return;
    const keys: InvoiceSortKey[] = ['poNumber', 'folio', 'client', 'issued', 'due', 'amount', 'status'];
    this.sortInvoices(keys[header.cellIndex]);
  }

  invoicePageStart() {
    return this.filteredInvoices().length ? (this.invoicePage() - 1) * this.invoicePageSize() + 1 : 0;
  }

  invoicePageEnd() {
    return Math.min(this.invoicePage() * this.invoicePageSize(), this.filteredInvoices().length);
  }

  onInvoiceSearch(value: string) {
    this.search.set(value);
    this.invoicePage.set(1);
  }

  onInvoiceStatus(value: 'all' | 'withReceiving' | 'withoutReceiving') {
    this.statusFilter.set(value);
    this.invoicePage.set(1);
  }

  onInvoiceCustomer(value: string) {
    this.customerFilter.set(value);
    this.invoicePage.set(1);
  }

  onInvoiceDateRange() {
    this.invoicePage.set(1);
  }

  constructor() {
    document.documentElement.lang = this.language();
    document.title = `${this.t('brand')} | ${this.t('portal')}`;
    const token = sessionStorage.getItem('fc-token');
    const savedUser = sessionStorage.getItem('fc-user');
    if (token && savedUser) {
      try {
        const profile = JSON.parse(savedUser);
        this.user.set(profile);
        this.activeTab.set('invoices');
        this.loadInvoices();
        if (profile.role === 'admin') this.loadClients();
        if (profile.role === 'admin' && this.reconciliationView()) this.loadReconciliation();
      } catch { this.clearSession(); }
    }
  }

  setLanguage(language: Language) {
    this.language.set(language);
    localStorage.setItem('fc-language', language);
    document.documentElement.lang = language;
    document.title = `${this.t('brand')} | ${this.t('portal')}`;
  }

  openReconciliation() {
    this.reconciliationView.set(true);
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'reconciliation');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
    if (this.user()?.role === 'admin') this.loadReconciliation();
  }

  cycleReconciliationResultSort() {
    const current = this.reconciliationSort();
    this.reconciliationSort.set(current === 'date' ? 'missing' : current === 'missing' ? 'found' : 'date');
  }

  showInvoices() {
    this.reconciliationView.set(false);
    this.activeTab.set('invoices');
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  showClients() {
    this.reconciliationView.set(false);
    this.activeTab.set('clients');
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  t(key: keyof typeof LOGIN_COPY.en) { return LOGIN_COPY[this.language()][key]; }

  statusLabel(invoice: Invoice) {
    if (invoice.status === 'Pagada') return this.t('paid');
    if (invoice.status === 'Pendiente') {
      return invoice.receivingSharePointUrl ? this.t('received') : this.t('pending');
    }
    return this.t('overdue');
  }

  login() {
    if (this.loginStep() === 'email') {
      if (!this.loginUser.trim()) return;
      this.loginStep.set('password');
      setTimeout(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        window.getSelection()?.removeAllRanges();
      });
      return;
    }
    if (!this.loginPassword.trim()) {
      this.loginError.set(this.language() === 'es' ? 'La contraseña es obligatoria.' : 'Password is required.');
      return;
    }
    this.loading.set(true);
    this.loginError.set('');
    this.http.post<{ token: string; user: { name: string; role: Role; email?: string; clientKey?: string } }>('/api/auth/login', {
      username: this.loginUser.trim(), password: this.loginPassword
    }).subscribe({
      next: response => {
        sessionStorage.setItem('fc-token', response.token);
        sessionStorage.setItem('fc-user', JSON.stringify(response.user));
        this.user.set(response.user);
        this.loginPassword = '';
        this.loading.set(false);
        this.loadInvoices();
        if (response.user.role === 'admin') this.loadClients();
      },
      error: error => {
        this.loading.set(false);
        this.loginError.set(this.errorMessage(error));
      }
    });
  }

  logout() {
    this.menuOpen.set(false);
    this.clearSession();
    this.loginPassword = '';
    this.loginStep.set('email');
    this.search.set('');
    this.selected.set(null);
    this.activeTab.set('invoices');
  }

  backToEmail() {
    this.loginStep.set('email');
    this.loginPassword = '';
    this.loginError.set('');
  }

  handleInvoicePdf(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0] || null;
    this.invoicePdfFile = file;
    if (!file) return;
    this.pdfReading.set(true);
    this.pdfError.set('');
    const formData = new FormData();
    formData.append('invoicePdf', file);
    if (this.receivingPdfFile) formData.append('receivingPdf', this.receivingPdfFile);
    this.http.post<Partial<Invoice>>('/api/invoices/parse', formData, this.authOptions()).subscribe({
      next: extracted => {
        this.newInvoice = { ...this.newInvoice, ...extracted };
        this.pdfReading.set(false);
        this.notify(this.language() === 'es' ? 'Datos de factura detectados.' : 'Invoice data detected.');
      },
      error: error => { this.pdfReading.set(false); this.pdfError.set(this.errorMessage(error)); }
    });
  }

  handleReceivingPdf(event: Event) {
    this.receivingPdfFile = (event.target as HTMLInputElement).files?.[0] || null;
  }

  uploadReceiving(invoice: Invoice, event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('receivingPdf', file);
    this.loading.set(true);
    this.http.patch<Invoice>(`/api/invoices/${invoice.id}/receiving`, formData, this.authOptions()).subscribe({
      next: updated => {
        this.invoices.update(items => items.map(item => item.id === updated.id ? updated : item));
        this.loading.set(false);
        this.notify(this.language() === 'es' ? 'Recibimiento guardado correctamente.' : 'Receiving document saved successfully.');
      },
      error: error => { this.loading.set(false); this.notify(this.errorMessage(error)); }
    });
    (event.target as HTMLInputElement).value = '';
  }

  replaceInvoicePdf(invoice: Invoice, event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('invoicePdf', file);
    this.loading.set(true);
    this.http.patch<Invoice>(`/api/invoices/${invoice.id}/invoice-pdf`, formData, this.authOptions()).subscribe({
      next: updated => {
        this.invoices.update(items => items.map(item => item.id === updated.id ? updated : item));
        this.invoiceActionTarget.set(null);
        this.loading.set(false);
        this.notify(this.language() === 'es' ? 'PDF de factura reemplazado correctamente.' : 'Invoice PDF replaced successfully.');
      },
      error: error => { this.loading.set(false); this.notify(this.errorMessage(error)); }
    });
    (event.target as HTMLInputElement).value = '';
  }

  replaceReceivingPdf(invoice: Invoice, event: Event) {
    this.uploadReceiving(invoice, event);
    this.invoiceActionTarget.set(null);
  }

  openInvoiceActions(invoice: Invoice, event: Event) {
    const button = event.currentTarget as HTMLElement | null;
    if (button) {
      const rect = button.getBoundingClientRect();
      this.invoiceActionMenuPosition.set({ top: rect.bottom + 6, left: Math.max(12, rect.right - 248) });
    }
    this.invoiceActionTarget.set(invoice);
  }

  openInvoiceEditor(invoice: Invoice) {
    this.editingInvoice.set(invoice);
    this.editInvoiceForm = {
      folio: invoice.folio,
      poNumber: invoice.poNumber || '',
      client: invoice.client,
      email: invoice.email,
      concept: invoice.concept,
      issued: invoice.issued,
      due: invoice.due,
      amount: invoice.amount,
      status: invoice.status
    };
    this.invoiceActionTarget.set(null);
    this.showEditInvoiceForm.set(true);
  }

  saveInvoiceChanges() {
    const invoice = this.editingInvoice();
    if (!invoice || !this.editInvoiceForm.client || !this.editInvoiceForm.email || !this.editInvoiceForm.concept || !this.editInvoiceForm.issued || !this.editInvoiceForm.due || !Number(this.editInvoiceForm.amount)) return;
    this.loading.set(true);
    this.http.patch<Invoice>(`/api/invoices/${invoice.id}`, this.editInvoiceForm, this.authOptions()).subscribe({
      next: updated => {
        this.invoices.update(items => items.map(item => item.id === updated.id ? updated : item));
        this.showEditInvoiceForm.set(false);
        this.editingInvoice.set(null);
        this.loading.set(false);
        this.notify(this.language() === 'es' ? 'Factura actualizada correctamente.' : 'Invoice updated successfully.');
      },
      error: error => { this.loading.set(false); this.notify(this.errorMessage(error)); }
    });
  }

  updateDueDate() {
    if (this.newInvoice.issued) this.newInvoice.due = this.addOneMonth(this.newInvoice.issued);
  }

  openPdf(type: 'invoice' | 'receiving', invoice: Invoice) {
    const url = type === 'invoice' ? invoice.invoiceSharePointUrl : invoice.receivingSharePointUrl;
    if (!url && !invoice.id) {
      this.notify(this.language() === 'es' ? 'Este archivo todavía no está disponible.' : 'This file is not available yet.');
      return;
    }
    const token = sessionStorage.getItem('fc-token');
    const endpoint = `/api/invoices/${invoice.id}/${type === 'invoice' ? 'pdf' : 'receiving-pdf'}?token=${token}`;
    window.open(endpoint, '_blank', 'noopener');
  }

  hasCreditPdf(invoice: Invoice): boolean {
    return !!(invoice.credits && invoice.credits.some(c => !!c.creditSharePointUrl));
  }

  openCreditPdf(invoice: Invoice, event: Event) {
    event.stopPropagation();
    const credit = invoice.credits?.find(c => !!c.creditSharePointUrl);
    if (credit?.creditSharePointUrl) {
      window.open(credit.creditSharePointUrl, '_blank', 'noopener');
    }
  }

  saveInvoice() {
    const amount = Number(this.newInvoice.amount);
    if (!this.newInvoice.client || !this.newInvoice.email || !this.newInvoice.concept || this.newInvoice.amount === undefined || this.newInvoice.amount === null || !Number.isFinite(amount) || amount < 0) return;
    this.loading.set(true);
    const formData = new FormData();
    for (const [key, value] of Object.entries(this.newInvoice)) {
      if (key !== 'id' && value !== undefined && value !== null) formData.append(key, String(value));
    }
    formData.set('amount', String(Number(this.newInvoice.amount)));
    if (this.invoicePdfFile) formData.append('invoicePdf', this.invoicePdfFile);
    if (this.receivingPdfFile) formData.append('receivingPdf', this.receivingPdfFile);
    this.http.post<Invoice>('/api/invoices', formData, this.authOptions()).subscribe({
      next: invoice => {
        this.invoices.update(items => [invoice, ...items]);
        this.showForm.set(false);
        this.newInvoice = this.emptyInvoice();
        this.invoicePdfFile = null;
        this.receivingPdfFile = null;
        this.pdfError.set('');
        this.loading.set(false);
        this.notify(this.t('createdSuccess'));
      },
      error: error => { this.loading.set(false); this.notify(this.errorMessage(error)); }
    });
  }

  markPaid(invoice: Invoice) {
    this.http.patch<Invoice>(`/api/invoices/${invoice.id}`, { status: 'Pagada' }, this.authOptions()).subscribe({
      next: updated => {
        this.invoices.update(items => items.map(item => item.id === updated.id ? updated : item));
        this.selected.set(updated);
        this.notify(this.t('paidSuccess'));
      },
      error: error => this.notify(this.errorMessage(error))
    });
  }

  deleteInvoice(invoice: Invoice) {
    this.confirmDeleteInvoice(invoice);
  }

  confirmDeleteInvoice(invoice: Invoice) {
    if (confirm(`${this.t('deleteConfirm')} ${invoice.folio}?`)) {
      this.http.delete(`/api/invoices/${invoice.id}`, this.authOptions()).subscribe({
        next: () => {
          this.invoices.update(items => items.filter(item => item.id !== invoice.id));
          this.invoiceActionTarget.set(null);
          this.selected.set(null);
          this.notify(this.t('deletedSuccess'));
        },
        error: error => this.notify(this.errorMessage(error))
      });
    }
  }

  printInvoice() { window.print(); }

  selectInvoiceClient(clientId: string) {
    const client = this.clients().find(item => item.id === Number(clientId));
    if (client) {
      this.newInvoice.client = client.name;
      this.newInvoice.email = client.email;
    }
  }

  openClientForm(client?: ClientUser) {
    this.editingClient.set(client || null);
    this.clientForm = client
      ? { name: client.name, username: client.username, email: client.email, password: '' }
      : { name: '', username: '', email: '', password: '' };
    this.showClientForm.set(true);
  }

  saveClient() {
    const editing = this.editingClient();
    if (!this.clientForm.name || !this.clientForm.username || !this.clientForm.email || (!editing && !this.clientForm.password)) return;
    this.loading.set(true);
    const request = editing
      ? this.http.patch<ClientUser>(`/api/users/${editing.id}`, this.clientForm, this.authOptions())
      : this.http.post<ClientUser>('/api/users', this.clientForm, this.authOptions());
    request.subscribe({
      next: client => {
        this.clients.update(items => editing ? items.map(item => item.id === client.id ? client : item) : [client, ...items]);
        this.showClientForm.set(false);
        this.loading.set(false);
        this.notify(editing ? this.t('clientUpdated') : this.t('clientCreated'));
      },
      error: error => { this.loading.set(false); this.notify(this.errorMessage(error)); }
    });
  }

  toggleClient(client: ClientUser) {
    this.http.patch<ClientUser>(`/api/users/${client.id}`, { active: !client.active }, this.authOptions()).subscribe({
      next: updated => {
        this.clients.update(items => items.map(item => item.id === updated.id ? updated : item));
        this.notify(this.t('clientUpdated'));
      },
      error: error => this.notify(this.errorMessage(error))
    });
  }

  deleteClient(client: ClientUser) {
    if (!confirm(`${this.t('deleteClientConfirm')} ${client.name}?`)) return;
    this.http.delete(`/api/users/${client.id}`, this.authOptions()).subscribe({
      next: () => {
        this.clients.update(items => items.filter(item => item.id !== client.id));
        this.notify(this.t('clientDeleted'));
      },
      error: error => this.notify(this.errorMessage(error))
    });
  }

  formatMoney(value: number) {
    return new Intl.NumberFormat(this.language() === 'en' ? 'en-US' : 'es-MX', { style: 'currency', currency: 'USD' }).format(value);
  }

  formatDate(value: string) {
    return new Intl.DateTimeFormat(this.language() === 'en' ? 'en-US' : 'es-MX', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));
  }

  initials(name: string) { return name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase(); }

  private notify(message: string) {
    this.toast.set(message);
    setTimeout(() => this.toast.set(''), 2600);
  }

  isSyncingCredits = signal(false);

  syncCredits() {
    this.isSyncingCredits.set(true);
    this.http.post<{ message: string }>('/api/credits/sync', {}, this.authOptions()).subscribe({
      next: res => {
        this.notify(res.message);
        this.loadInvoices();
        this.isSyncingCredits.set(false);
      },
      error: error => {
        this.notify(this.errorMessage(error));
        this.isSyncingCredits.set(false);
      }
    });
  }

  private loadInvoices() {
    this.loading.set(true);
    this.http.get<Invoice[]>('/api/invoices', this.authOptions()).subscribe({
      next: invoices => { this.invoices.set(invoices); this.loading.set(false); },
      error: error => {
        this.loading.set(false);
        if (error.status === 401) this.clearSession();
        else this.notify(this.errorMessage(error));
      }
    });
  }

  private loadClients() {
    this.http.get<ClientUser[]>('/api/users', this.authOptions()).subscribe({
      next: clients => this.clients.set(clients),
      error: error => this.notify(this.errorMessage(error))
    });
  }

  loadReconciliation() {
    this.reconciliationLoading.set(true);
    this.http.get<ReconciliationResponse>('/api/reconciliation', this.authOptions()).subscribe({
      next: result => {
        this.reconciliationRows.set(result.rows);
        this.reconciliationTotals.set(result.totals);
        this.reconciliationSource.set(result.source);
        this.reconciliationLoading.set(false);
      },
      error: error => {
        this.reconciliationLoading.set(false);
        this.notify(this.errorMessage(error));
      }
    });
  }

  uploadReconciliationExcel(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.reconciliationLoading.set(true);
    const formData = new FormData();
    formData.append('excel', file);
    this.http.post<{message: string}>('/api/reconciliation/upload', formData, this.authOptions()).subscribe({
      next: (res) => {
        this.notify(res.message);
        this.loadReconciliation();
      },
      error: error => {
        this.reconciliationLoading.set(false);
        this.notify(this.errorMessage(error));
      }
    });
  }

  private authOptions() {
    return { headers: new HttpHeaders({ Authorization: `Bearer ${sessionStorage.getItem('fc-token') || ''}` }) };
  }

  private clearSession() {
    sessionStorage.removeItem('fc-token');
    sessionStorage.removeItem('fc-user');
    this.user.set(null);
    this.invoices.set([]);
    this.clients.set([]);
  }

  private errorMessage(error: HttpErrorResponse) {
    if (!error.error?.message) return this.t('connectionError');
    if (this.language() === 'en') {
      if (error.status === 401) return 'Incorrect username or password.';
      if (error.status === 403) return 'You do not have permission to perform this action.';
    }
    return error.error.message;
  }

  private emptyInvoice(): Invoice {
    const today = new Date().toISOString().slice(0, 10);
    return { id: 0, folio: '', poNumber: '', client: '', email: '', concept: '', issued: today, due: this.addOneMonth(today), amount: 0, status: 'Pendiente' };
  }

  private emptyEditInvoice() {
    const today = new Date().toISOString().slice(0, 10);
    return { folio: '', poNumber: '', client: '', email: '', concept: '', issued: today, due: this.addOneMonth(today), amount: 0, status: 'Pendiente' as Status };
  }

  private addOneMonth(dateText: string) {
    const date = new Date(`${dateText}T00:00:00`);
    date.setMonth(date.getMonth() + 1);
    return date.toISOString().slice(0, 10);
  }
}
