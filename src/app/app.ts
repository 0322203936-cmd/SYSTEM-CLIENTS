import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { AfterViewChecked, AfterViewInit, Component, computed, effect, ElementRef, HostListener, inject, OnDestroy, signal, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { SVGIconModule } from '@progress/kendo-angular-icons';
import { companyTemplateKey, clientTemplateKey, findClientTemplate } from './email-template-keys';
import { firstValueFrom } from 'rxjs';
import { buildBulkSendRows, bulkSendSummary, BulkSendInvoice, BulkSendRow } from './bulk-send';
import { buildBulkStatementRows, bulkStatementSummary, bulkStatementQueue, BulkStatementGroup, BulkStatementRow } from './bulk-statement';
import { shouldUseWalmexCache } from './walmex-cache-policy.mjs';
import { visibleStatementCompanies } from './statement-company-policy.mjs';
import { accountStatementInvoiceBalance } from './account-statement-balance.mjs';
import { getPortalStartupView } from './portal-startup-view.mjs';
import { cartIcon, clipboardTextIcon, documentManagerIcon, dollarIcon, fileReportIcon, gearIcon, globeOutlineIcon, layout2By2Icon, userOutlineIcon } from '@progress/kendo-svg-icons';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { EditorComponent } from '@tinymce/tinymce-angular';
import { TableModule } from 'primeng/table';
import { DropdownModule } from 'primeng/dropdown';
import { CalendarModule } from 'primeng/calendar';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectButtonModule } from 'primeng/selectbutton';
import { faBell, faChevronDown, faEnvelope, faFloppyDisk, faGear, faHeadset, faLock, faPencil, faPhone, faPrint, faRightFromBracket, faShareFromSquare, faSpinner, faTrashCan, faUser } from '@fortawesome/free-solid-svg-icons';
import { faUser as faUserRegular } from '@fortawesome/free-regular-svg-icons';
import { CategoryScale, Chart, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js';
// xlsx-js-style pesa varios MB y solo se usa al exportar a Excel, así que se
// carga bajo demanda en vez de viajar en el paquete inicial.


type Status = 'Pagada' | 'Pendiente' | 'Vencida';
type Role = 'admin' | 'client';
type PortalPermission = 'dashboard' | 'invoices' | 'checks' | 'support' | 'credits' | 'reconciliation' | 'accountStatement' | 'settings' | 'users' | 'preferences';
type Language = 'en' | 'es';
type InvoiceSortKey = 'poNumber' | 'guideNumber' | 'folio' | 'client' | 'issued' | 'due' | 'amount' | 'status';
type InvoiceView = 'all' | 'pending' | 'received' | 'paid' | 'overdue' | 'returns';
type InvoiceSearchField = 'number' | 'client' | 'concept';
type AccountStatementSortKey = 'expiration' | 'date' | 'poNumber' | 'invoice' | 'daysExpiration' | AccountStatementAgingBucket;
type ReconciliationSort = 'date' | 'missing' | 'found';
type ReconciliationFilterKey = 'folio' | 'series' | 'client' | 'result' | 'validation';
type CreditReconciliationFilterKey = 'po' | 'folio' | 'client' | 'date' | 'validation';

Chart.register(CategoryScale, LinearScale, PointElement, LineController, LineElement, Filler, Tooltip, Legend);

interface UserProfile {
  id: number | string;
  name: string;
  role: Role;
  email?: string;
  clientKey?: string;
  assignedClients?: string[];
  permissions?: PortalPermission[];
  firstName?: string;
  lastName?: string;
  phone?: string;
}

interface AccountForm {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

interface PasswordForm {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

interface AuthResponse {
  token: string;
  user: UserProfile;
}

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
    logout: 'Sign out', customerSupport: 'Customer support',
    balance: 'Balance',
    syncCredits: 'Sync Credits',
    syncInvoices: 'Sync Invoices',
    usernamePlaceholder: 'you@email.com',
    show: 'Show', hide: 'Hide', submit: 'Sign in to my account', demo: 'Client demo access',
    protected: 'Your data is protected and encrypted.', connectionError: 'Unable to connect to the server.',
    adminPanel: 'Admin dashboard', myAccount: 'My account', profile: 'Profile', accountSettings: 'Account settings', personalInfo: 'Personal information', changePassword: 'Change password', firstName: 'First name', lastName: 'Last name', phone: 'Mobile phone', currentPassword: 'Current password', newPassword: 'New password', confirmPassword: 'Confirm password', accountSaved: 'Account information updated.', passwordChanged: 'Password changed successfully.', requiredFields: 'Complete the required fields.', passwordMismatch: 'Passwords do not match.', accountLoadError: 'Unable to load your account.', preferences: 'Preferences', technicalSupport: 'System information', about: 'System', technicalDescription: 'The Pacifica Farms Client Portal centralizes invoices, receiving documents, balances, and account statements in one secure workspace.', copyright: 'System information', project: 'System', version: 'Version', developedBy: 'Managed by', website: 'Website', contact: 'Contact', supportContact: 'For questions or support, use Customer support from your account menu.', supportChannel: 'Support channel', supportProject: 'Pacifica Farms Client Portal', supportVersion: '1.0.0', supportDeveloper: 'Pacifica Farms', supportWebsite: 'pacifica-farms.com', supportDescription: 'Use this section to identify the platform and contact the administrator about access, invoice data, receiving documents, or system operation:', supportEmail: 'Email', supportWhatsapp: 'WhatsApp', supportSubject: 'When requesting help, include the module and document number related to your request.', clientPortalTitle: 'Client Portal', clientPortalSubtitle: 'View your invoices and receiving documents',
    manageTitle: 'Invoice management', myInvoices: 'My invoices', manageSubtitle: 'Manage and track your clients’ invoices.',
    clientSubtitle: 'View the status and details of all your documents.', newInvoice: 'New invoice', totalBilling: 'Total billing',
    registeredInvoices: 'invoices registered', paid: 'Paid', completedPayments: 'Completed payments', outstanding: 'Outstanding',
    followUp: 'Requires follow-up', searchPlaceholder: 'Search by number, client, or description', all: 'All', allStatuses: 'All', allCustomers: 'All customers', dateRange: 'Date range', receivingFilter: 'Receiving', withReceiving: 'With receiving', withoutReceiving: 'Without receiving', pending: 'Pending', overdue: 'Overdue', received: 'Received',
    invoice: 'Invoice', customer: 'Customer', issued: 'Issued', due: 'Due date', amount: 'Amount', balanceSystem: 'System balance', balanceContPaq: 'ContPAQ balance', status: 'Status', action: 'Action',
    reconciliation: 'Task Center', checks: 'Checks', uploadExcel: 'Upload Excel', systemInvoices: 'Invoices in system', excelInvoices: 'Invoices in ContPAQ', totalAmount: 'Total amount', totalSystemBalance: 'Total system balance', totalContPaqBalance: 'Total ContPAQ balance', filterByDate: 'Filter by date', refresh: 'Refresh', folioLabel: 'Invoice', seriesPo: 'Series / PO', dateLabel: 'Date', resultLabel: 'Result', foundResult: 'Found', missingResult: 'Missing', readingExcel: 'Reading Excel…', noReconciliation: 'No invoices to reconcile.',
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
    companyName: 'PACIFICA FARMS', loginDescription: 'Your solution for viewing invoices and tracking payments.', emailLabel: 'Email *', continueLabel: 'Continue', signInLabel: 'Sign in', loginWithLabel: 'Login With Pacifica', authenticating: 'Authenticating', joinUs: 'Join Us', joinConnect: 'Join Connect', forgotPassword: 'Forgot Password?',
    invoicesTab: 'Invoices', clientsTab: 'Clients',
    accessInfo: 'Access Information', viewPermissions: 'Viewing Permissions', viewPermissionsDesc: 'Select the companies for which this agent can view invoices and documents.',
    deleteAccount: 'Delete account', deleteAccountDesc: 'If you delete this user, they will no longer be able to access the portal.',
    selectUserToManage: 'Select a user from the list to manage their access permissions.', dashboard: 'Dashboard'
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
    logout: 'Cerrar sesión', customerSupport: 'Atención al cliente',
    balance: 'Saldo',
    syncCredits: 'Sincronizar Créditos',
    syncInvoices: 'Sincronizar Facturas',
    username: 'Usuario o correo', usernamePlaceholder: 'tu@correo.com',
    show: 'Ver', hide: 'Ocultar', submit: 'Ingresar a mi cuenta', demo: 'Acceso de demostración para cliente',
    protected: 'Tus datos se encuentran protegidos y cifrados.', connectionError: 'No fue posible conectar con el servidor.',
    adminPanel: 'Panel administrativo', myAccount: 'Mi cuenta', profile: 'Perfil', accountSettings: 'Configuración de la cuenta', personalInfo: 'Información personal', changePassword: 'Cambiar contraseña', firstName: 'Nombres', lastName: 'Apellidos', phone: 'Celular', currentPassword: 'Contraseña actual', newPassword: 'Nueva contraseña', confirmPassword: 'Confirmar contraseña', accountSaved: 'La información de la cuenta se actualizó.', passwordChanged: 'La contraseña se cambió correctamente.', requiredFields: 'Completa los campos obligatorios.', passwordMismatch: 'Las contraseñas no coinciden.', accountLoadError: 'No fue posible cargar tu cuenta.', preferences: 'Preferencias', technicalSupport: 'Información del sistema', about: 'Sistema', technicalDescription: 'El Portal de clientes de Pacifica Farms centraliza facturas, recibimientos, saldos y estados de cuenta en un solo espacio seguro.', copyright: 'Información del sistema', project: 'Sistema', version: 'Versión', developedBy: 'Administrado por', website: 'Sitio web', contact: 'Contacto', supportContact: 'Para dudas o soporte, utiliza Atención al cliente desde el menú de tu cuenta.', supportChannel: 'Canal de soporte', supportProject: 'Portal de clientes Pacifica Farms', supportVersion: '1.0.0', supportDeveloper: 'Pacifica Farms', supportWebsite: 'pacifica-farms.com', supportDescription: 'Consulta esta sección para conocer la plataforma y contactar al administrador sobre accesos, facturas, recibimientos o el funcionamiento del sistema:', supportEmail: 'Correo', supportWhatsapp: 'WhatsApp', supportSubject: 'Para recibir ayuda, indica el módulo y el número de documento relacionado con tu solicitud.', clientPortalTitle: 'Portal de clientes', clientPortalSubtitle: 'Consulta tus facturas y documentos de recibimiento',
    manageTitle: 'Gestión de facturas', myInvoices: 'Mis facturas', manageSubtitle: 'Administra y da seguimiento a la facturación de tus clientes.',
    clientSubtitle: 'Consulta el estado y detalle de todos tus comprobantes.', newInvoice: 'Nueva factura', totalBilling: 'Facturación total',
    registeredInvoices: 'facturas registradas', paid: 'Pagado', completedPayments: 'Cobros completados', outstanding: 'Por cobrar',
    followUp: 'Requiere seguimiento', searchPlaceholder: 'Buscar por folio, cliente o concepto', all: 'Todas', allStatuses: 'Todos', allCustomers: 'Todos los clientes', dateRange: 'Rango de fechas', receivingFilter: 'Recibimiento', withReceiving: 'Con recibimiento', withoutReceiving: 'Sin recibimiento', pending: 'Pendiente', overdue: 'Vencida', received: 'Recibido',
    invoice: 'Factura', customer: 'Cliente', issued: 'Emisión', due: 'Vencimiento', amount: 'Importe', balanceSystem: 'Balance Sistema', balanceContPaq: 'Balance ContPAQ', status: 'Estado', action: 'Acción',
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
    deactivate: 'Desactivar', activate: 'Activar', deleteClientConfirm: 'Eliminar al cliente', accountCredentials: 'Para agregar otro contacto, usa el mismo nombre del cliente y un correo diferente.', clientAccount: 'Client account',
    reconciliation: 'Centro de Tareas', checks: 'Cheques', uploadExcel: 'Subir Excel', systemInvoices: 'Facturas en el sistema', excelInvoices: 'Facturas en ContPAQ', totalAmount: 'Importe total', totalSystemBalance: 'Balance total del sistema', totalContPaqBalance: 'Balance total ContPAQ', filterByDate: 'Filtrar por fecha', refresh: 'Actualizar', folioLabel: 'Factura', seriesPo: 'Serie / PO', dateLabel: 'Fecha', resultLabel: 'Resultado', foundResult: 'Encontrada', missingResult: 'Faltante', readingExcel: 'Leyendo Excel…', noReconciliation: 'No hay facturas para conciliar.',
    companyName: 'PACIFICA FARMS', loginDescription: 'Tu solución para consultar tus facturas y dar seguimiento a tus pagos.', emailLabel: 'Correo electrónico *', continueLabel: 'Continuar', signInLabel: 'Ingresar', loginWithLabel: 'Ingresar a Pacifica', authenticating: 'Autenticando', joinUs: 'Crear cuenta', joinConnect: 'Conectar', forgotPassword: '¿Olvidaste tu contraseña?',
    accessInfo: 'Información de acceso', viewPermissions: 'Permisos de visualización', viewPermissionsDesc: 'Selecciona las empresas de las cuales este agente puede ver facturas y comprobantes.',
    deleteAccount: 'Eliminar cuenta', deleteAccountDesc: 'Si eliminas a este usuario ya no podrá acceder al portal.',
    selectUserToManage: 'Selecciona un usuario de la lista para gestionar sus permisos de acceso.', dashboard: 'Dashboard'
  }
} as const;

interface CreditRecord {
  creditNumber: string;
  amount: number;
  documentOnly?: boolean;
  guideNumber?: string;
  dateProcessed: string;
  date?: string;
  creditPdfPath: string;
  creditSharePointUrl: string;
  creditFlagTargetInvoiceId?: number;
  creditFlagHidden?: boolean;
}

interface Invoice {
  id: number | string;
  folio: string;
  client: string;
  location?: string;
  clientKey?: string;
  email: string;
  concept: string;
  searchText?: string;
  issued: string;
  due: string;
  amount: number;
  status: Status;
  poNumber?: string;
  guideNumber?: string;
  invoiceFileName?: string;
  invoicePdfPath?: string;
  receivingFileName?: string;
  receivingPdfPath?: string;
  invoiceSharePointUrl?: string;
  receivingSharePointUrl?: string;
  creditAmount?: number;
  balance?: number;
  checkApplications?: { date: string; amount: number }[];
  credits?: CreditRecord[];
  reconciliationStatus?: string;
  walmexSource?: boolean;
  readOnly?: boolean;
}

interface Agent {
  id: number;
  name: string;
  email?: string;
  clients: string[];
  createdAt?: string;
}

interface InvoiceGridColumn {
  key: InvoiceSortKey | 'balance' | 'devolucion';
  label: string;
  visible: boolean;
  locked?: boolean;
  /** Ancho fijo en px, igual que el colgroup del grid de Orders. */
  width: number;
  align?: 'center' | 'right';
}

type AccountStatementAgingBucket = '0' | '1-30' | '31-60' | '61-90' | '90+';

interface AccountStatementAgingRow {
  invoice: Invoice;
  customerCode: string;
  customerName: string;
  daysExpiration: number;
  agingBucket: AccountStatementAgingBucket;
  bucketAmounts: Record<AccountStatementAgingBucket, number>;
  balance: number;
}

interface AccountStatementCustomerGroup {
  customerCode: string;
  customerName: string;
  rows: AccountStatementAgingRow[];
  totals: Record<AccountStatementAgingBucket, number> & { balance: number };
}

interface ReconciliationRow {
  folio: string;
  series: string;
  client: string;
  date: string;
  total: number;
  balanceSystem: number | null;
  balanceContPaq: number | null;
  inContPaq: boolean;
  inSystem: boolean;
  sourceStatus: 'both' | 'contpaq' | 'system';
  existsInSystem: boolean;
  systemInvoiceId: number | null;
  validation: 'valid' | 'amount-different' | 'missing' | 'live-invoice' | 'excel-duplicate' | 'system-duplicate' | 'both-duplicate';
}

interface ReconciliationResponse {
  source: string;
  statementSource?: string | null;
  statementUploadedAt?: string | null;
  rows: ReconciliationRow[];
  totals: { excel: number; found: number; missing: number };
  pagination?: { page: number; pageSize: number; total: number };
}

interface CreditReconciliationRow {
  po: string;
  folios: string;
  client: string;
  date: string;
  systemCredits: string;
  systemAmount: number | null;
  excelAmount: number | null;
  difference: number | null;
  agent: string;
  systemCount: number;
  excelCount: number;
  sourceStatus: 'both' | 'system' | 'excel';
  validation: 'valid' | 'amount-different' | 'missing' | 'duplicate';
}

interface CreditReconciliationResponse {
  source: string;
  rows: CreditReconciliationRow[];
  totals: { excel: number; system: number; both: number; missing: number; different: number };
  pagination?: { page: number; pageSize: number; total: number };
}

type SupportTicketStatus = 'open' | 'in_progress' | 'resolved';

interface SupportReply {
  id: number;
  authorId: number | string;
  authorName: string;
  authorRole: string;
  message: string;
  createdAt: string;
}

interface SupportTicket {
  id: number;
  number: string;
  category: string;
  subject: string;
  message: string;
  userId: number | string;
  userName: string;
  email: string;
  role: string;
  clientKey: string;
  status: SupportTicketStatus;
  createdAt: string;
  replies: SupportReply[];
}

interface PortalNotification {
  id: number;
  userId: number | string;
  type: 'support_reply';
  title: string;
  message: string;
  ticketId: number;
  ticketNumber: string;
  read: boolean;
  createdAt: string;
}

interface SyncIssue {
  file?: string;
  invoice?: string;
  po?: string;
  credit?: string;
  amount?: number;
  replacement?: { kind?: 'invoice' | 'receiving'; sourceFileId: string; existingInvoiceId?: number; invoiceIds?: number[]; invoiceOptions?: Array<{ id: number; folio: string; client: string }> };
  creditAction?: { sourceFileId: string; creditNumber: string; amount: number; customer?: string; invoiceOptions?: Array<{ id: number; folio: string; client: string; balance: number }> };
  creditAssignment?: { sourceFileId: string; creditNumber: string; amount: number; customer?: string; invoiceOptions: Array<{ id: number; folio: string; client: string; balance: number }> };
  status: 'error' | 'warning' | 'missing' | 'duplicate' | 'removed';
  reason: string;
}

interface SyncDetailTarget {
  folio: string;
  client: string;
  amount?: number;
}

interface SyncDetail {
  file: string;
  type: 'invoice' | 'receiving' | 'credit';
  status: 'processed' | 'linked' | 'duplicate';
  targets: SyncDetailTarget[];
  reason: string;
}

interface SyncResult {
  message: string;
  processed?: number;
  skipped?: number;
  updatedBalances?: number;
  markedPaid?: number;
  issues: SyncIssue[];
  details?: SyncDetail[];
}

interface InvoiceSyncJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  total: number;
  scanned: number;
  processed: number;
  skipped: number;
  currentFile: string;
  message: string;
  issues: SyncIssue[];
  details: SyncDetail[];
  startedAt?: string | null;
  finishedAt?: string | null;
}

interface CheckAllocation {
  invoiceId: number | string;
  folio: string;
  amount: number;
}

interface CheckRecord {
  id: number;
  date: string;
  series: string;
  client: string;
  total: number;
  allocations: CheckAllocation[];
  createdAt: string;
}

interface EmailTemplate {
  clientKey: string;
  client: string;
  to: string;
  cc: string;
  subject: string;
  bodyHtml: string;
  logo: string;
  updatedAt?: string;
  updatedBy?: string;
}

interface ClientUser {
  id: number;
  name: string;
  username: string;
  email: string;
  clientKey?: string;
  assignedClients?: string[];
  role: Role;
  permissions?: PortalPermission[];
  active: boolean;
  createdAt?: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatIconModule, MatMenuModule, MatSelectModule, SVGIconModule, FaIconComponent, EditorComponent, TableModule, DropdownModule, CalendarModule, MultiSelectModule, SelectButtonModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements AfterViewChecked, AfterViewInit, OnDestroy {
  readonly Math = Math;
  readonly faBell = faBell;
  readonly faChevronDown = faChevronDown;
  readonly faHeadset = faHeadset;
  readonly faRightFromBracket = faRightFromBracket;
  readonly faUserIcon = faUserRegular;
  readonly faGearIcon = faGear;
  readonly faEnvelopeIcon = faEnvelope;
  readonly faFloppyDiskIcon = faFloppyDisk;
  readonly faLockIcon = faLock;
  readonly faPhoneIcon = faPhone;
  readonly faSpinnerIcon = faSpinner;
  readonly faPencilIcon = faPencil;
  readonly faPrintIcon = faPrint;
  readonly faShareIcon = faShareFromSquare;
  readonly faTrashIcon = faTrashCan;
  readonly kendoDashboardIcon = layout2By2Icon;
  readonly kendoInvoicesIcon = fileReportIcon;
  readonly kendoChecksIcon = clipboardTextIcon;
  readonly kendoSupportIcon = userOutlineIcon;
  readonly kendoCreditsIcon = dollarIcon;
  readonly kendoReconciliationIcon = cartIcon;
  readonly kendoStatementIcon = documentManagerIcon;
  readonly kendoSettingsIcon = gearIcon;
  readonly kendoPreferencesIcon = globeOutlineIcon;
  private dashboardChart?: Chart;
  dashboardChartReady = signal(false);
  private dashboardCanvasElement?: HTMLCanvasElement;
  @ViewChild('dashboardChartCanvas')
  dashboardChartCanvasRef?: ElementRef<HTMLCanvasElement>;
  private readonly http = inject(HttpClient);
  private readonly sanitizer = inject(DomSanitizer);
  loginUser = '';
  language = signal<Language>((localStorage.getItem('fc-language') as Language) || 'en');
  loginPassword = '';
  loginStep = signal<'email' | 'password'>('email');
  loginError = signal('');
  showPassword = signal(false);
  user = signal<UserProfile | null>(null);
  search = signal('');
  statusFilter = signal<'all' | 'withReceiving' | 'withoutReceiving'>('all');
  customerFilter = signal<string[]>([]);
  customerFilterOpen = signal(false);
  /** El rango se rellena al cargar: de la factura mas antigua hasta hoy. */
  dateFrom = signal('');
  dateTo = signal(App.todayIso());
  /** Evita reponer el rango si el usuario ya lo cambio. */
  private invoiceRangeInitialized = false;

  private static todayIso() {
    const date = new Date();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }
  invoiceView = signal<InvoiceView>('all');
  invoiceSearchField = signal<InvoiceSearchField>('number');
  /** Buscador de la barra de Facturas, independiente del global de arriba. */
  invoiceSearch = signal('');
  invoiceFilterOpen = signal(false);
  invoiceColumnChooserOpen = signal(false);
  invoiceColumns = signal<InvoiceGridColumn[]>([
    { key: 'poNumber', label: 'PO Number', visible: true, locked: true, width: 200 },
    { key: 'guideNumber', label: 'Guide', visible: true, locked: true, width: 150 },
    { key: 'folio', label: 'Invoice', visible: true, locked: true, width: 150 },
    { key: 'client', label: 'Customer', visible: true, width: 200 },
    { key: 'issued', label: 'Issued', visible: true, width: 120 },
    { key: 'due', label: 'Due date', visible: true, width: 120 },
    { key: 'amount', label: 'Amount (USD)', visible: true, width: 130 },
    { key: 'balance', label: 'Balance', visible: true, width: 150 },
    { key: 'devolucion', label: 'Credit', visible: true, width: 140 },
    { key: 'status', label: 'Status', visible: true, width: 130 },
  ]);
  /** Las tres primeras columnas van congeladas, igual que el grid de Orders. */
  private readonly invoiceFrozenCount = 3;
  invoicePage = signal(1);
  invoicePageSize = signal(10);
  invoiceSortKey = signal<InvoiceSortKey>('issued');
  invoiceSortDirection = signal<'asc' | 'desc'>('desc');
  showForm = signal(false);
  activeTab = signal<'dashboard' | 'invoices' | 'clients'>('dashboard');
  reconciliationView = signal(false);
  taskCenterTab = signal('reconciliation');
  checksSubTab = signal<'register' | 'report'>('register');
  checks = signal<CheckRecord[]>([]);
  checksDateFrom = signal('');
  checksDateTo = signal('');
  checksSearch = signal('');
  checksSearchField = signal<'series' | 'client' | 'folio'>('series');
  checksSortKey = signal<'index' | 'date' | 'series' | 'client' | 'total'>('date');
  checksSortDir = signal<'asc' | 'desc'>('desc');
  checksPage = signal(1);
  checksPageSize = signal(10);
  selectedCheckIds = signal<number[]>([]);
  checksActionMenuId = signal<number | null>(null);
  creditsSearch = signal('');
  creditsSearchField = signal<'customer' | 'credit' | 'invoice' | 'po' | 'guide'>('customer');
  creditsDateFrom = signal('');
  creditsDateTo = signal('');
  creditsSortKey = signal<'customer' | 'credit' | 'invoice' | 'po' | 'guide' | 'date' | 'amount'>('date');
  creditsSortDir = signal<'asc' | 'desc'>('desc');
  creditsPage = signal(1);
  creditsPageSize = signal(10);
  selectedCreditKeys = signal<string[]>([]);
  checksExportMenuOpen = signal(false);
  checksDateMenuOpen = signal(false);
  checksCalMonth = signal(new Date());
  showCheckEditor = signal(false);
  expandedChecks = signal<number[]>([]);
  editingCheck = signal<CheckRecord | null>(null);
  editCheckForm = signal<{ date: string; series: string; allocations: { invoiceId: number | string; folio: string; poNumber: string; amount: number }[] }>({ date: '', series: '', allocations: [] });
  checkDate = signal(new Date().toISOString().slice(0, 10));
  checkSeries = signal('');
  checkClient = signal('');
  checkTotal = signal('');
  selectedCheckInvoiceIds = signal<(number | string)[]>([]);
  checkInvoiceAmounts = signal<Record<string, number>>({});
  // Envío de factura + recibimiento por correo
  emailDialogOpen = signal(false);
  emailInvoice = signal<Invoice | null>(null);
  emailTo = signal('');
  emailCc = signal('');
  emailSubject = signal('');
  emailBody = signal('');
  // Solo cambia al abrir el diálogo: si el editor se enlazara a emailBody, el
  // cursor saltaría al inicio en cada tecla.
  emailBodyInitial = signal('');
  emailLogo = signal('');
  emailSaveTemplate = signal(true);
  emailAgent = signal<Agent | null>(null);
  emailIncludeAgent = signal(false);
  emailSending = signal(false);
  emailTemplates = signal<EmailTemplate[]>([]);
  emailReady = signal(true);
  emailFrom = signal('');
  // De dónde salió el contenido que se está mostrando: plantilla del cliente,
  // plantilla general o el texto base del sistema.
  emailTemplateOrigin = signal<'company' | 'client' | 'general' | 'none'>('none');
  emailTemplateCompany = signal('');
  statementCustomerFilter = signal<string[]>([]);
  statementCustomerFilterOpen = signal(false);
  accountStatementSortKey = signal<AccountStatementSortKey>('daysExpiration');
  accountStatementSortDirection = signal<'asc' | 'desc'>('desc');
  // Un solo selector combina empresa y agente: 'all' | 'pacifica' | 'centro'
  // o 'agent:<id>'. La empresa se deriva para el resto de la logica.
  statementScope = signal<string>('all');
  statementVisibleCompanies = computed(() => {
    const current = this.user();
    const issuers = this.invoices()
      .filter(invoice => this.invoiceVisibleToUser(invoice, current))
      .map(invoice => this.invoiceIssuerKey(invoice));
    return visibleStatementCompanies(current?.role, issuers) as ('pacifica' | 'centro')[];
  });
  statementCompany = computed<'all' | 'pacifica' | 'centro'>(() => {
    const scope = this.statementScope();
    const visible = this.statementVisibleCompanies();
    if (scope === 'pacifica' || scope === 'centro') {
      return visible.includes(scope) || this.user()?.role === 'admin' ? scope : (visible.length === 1 ? visible[0] : 'all');
    }
    return visible.length === 1 ? visible[0] : 'all';
  });
  statementAgent = computed<Agent | null>(() => {
    const scope = this.statementScope();
    if (!scope.startsWith('agent:')) return null;
    const id = scope.slice(6);
    return this.agents().find(agent => String(agent.id) === id) || null;
  });
  stmtEmailOpen = signal(false);
  stmtEmailGroup = signal<any | null>(null);
  stmtEmailTo = signal('');
  stmtEmailCc = signal('');
  stmtEmailSubject = signal('');
  stmtEmailBody = signal('');
  stmtEmailBodyInitial = signal('');
  stmtEmailLogo = signal('');
  stmtEmailFormat = signal<'excel' | 'image'>('excel');
  stmtEmailSaveTemplate = signal(true);
  stmtEmailSending = signal(false);
  stmtEmailAgent = signal<Agent | null>(null);
  stmtEmailAgentTo = signal('');
  stmtEmailIncludeAgent = signal(false);
  stmtEmailPreview = signal('');
  statementDateFrom = signal('');
  statementDateTo = signal('');
  accountStatementViewMode = signal<'detailed' | 'summary'>('detailed');
  creditReportCustomerFilter = signal<string[]>([]);
  creditReportCustomerFilterOpen = signal(false);
  reconciliationRows = signal<ReconciliationRow[]>([]);
  reconciliationTotals = signal({ excel: 0, found: 0, missing: 0 });
  reconciliationSource = signal('');
  reconciliationStatementSource = signal('');
  reconciliationLoading = signal(false);
  reconciliationDateFrom = signal('');
  reconciliationDateTo = signal('');
  reconciliationSort = signal<ReconciliationSort>('date');
  reconciliationHeaderFilter = signal<ReconciliationFilterKey | null>(null);
  reconciliationFolioFilter = signal('');
  reconciliationSeriesFilter = signal('');
  reconciliationClientFilter = signal('');
  reconciliationResultFilter = signal<'all' | 'both' | 'contpaq' | 'system'>('all');
  reconciliationValidationFilter = signal<'all' | 'valid' | 'duplicate' | 'amount-different' | 'missing' | 'live-invoice'>('all');
  reconciliationSection = signal<'invoices' | 'credits'>('invoices');
  creditReconciliationRows = signal<CreditReconciliationRow[]>([]);
  creditReconciliationTotals = signal({ excel: 0, system: 0, both: 0, missing: 0, different: 0 });
  creditReconciliationSource = signal('');
  creditReconciliationLoading = signal(false);
  creditReconciliationHeaderFilter = signal<CreditReconciliationFilterKey | null>(null);
  creditReconciliationPoFilter = signal('');
  creditReconciliationFolioFilter = signal('');
  creditReconciliationClientFilter = signal('');
  creditReconciliationDateFilter = signal('');
  creditReconciliationValidationFilter = signal<'all' | 'valid' | 'amount-different' | 'missing' | 'duplicate'>('all');
  creditReconciliationMatchedCount = computed(() => this.creditReconciliationRows().filter(row => row.validation === 'valid').length);
  creditReconciliationReviewCount = computed(() => this.creditReconciliationRows().filter(row => row.validation === 'duplicate').length + this.creditReconciliationTotals().missing);
  clients = signal<ClientUser[]>([]);
  agents = signal<Agent[]>([]);
  agentSearch = signal('');
  showAgentForm = signal(false);
  editingAgent = signal<Agent | null>(null);
  agentForm = { name: '', email: '', clients: [] as string[] };
  agentSaving = signal(false);
  showClientForm = signal(false);
  editingClient = signal<ClientUser | null>(null);
  clientForm = { name: '', username: '', email: '', password: '', role: 'client' as Role, permissions: [] as PortalPermission[], assignedClients: [] as string[] };
  readonly portalModuleOptions: { key: PortalPermission; es: string; en: string; icon: string }[] = [
    { key: 'dashboard', es: 'Dashboard', en: 'Dashboard', icon: 'dashboard' },
    { key: 'invoices', es: 'Facturas', en: 'Invoices', icon: 'receipt_long' },
    { key: 'checks', es: 'Checks', en: 'Checks', icon: 'shopping_bag' },
    { key: 'support', es: 'Atención al cliente', en: 'Customer support', icon: 'support_agent' },
    { key: 'credits', es: 'Créditos', en: 'Credits', icon: 'edit_document' },
    { key: 'reconciliation', es: 'Reconciliación', en: 'Reconciliation', icon: 'local_shipping' },
    { key: 'accountStatement', es: 'Estado de cuenta', en: 'Account statement', icon: 'account_balance' },
    { key: 'settings', es: 'Configuración', en: 'Settings', icon: 'settings' },
    { key: 'users', es: 'Usuarios', en: 'Users', icon: 'manage_accounts' },
    { key: 'preferences', es: 'Preferencias', en: 'Preferences', icon: 'tune' }
  ];
  clientPermissionSearch = signal('');
  selected = signal<Invoice | null>(null);
  invoiceActionTarget = signal<Invoice | null>(null);
  invoiceActionMenuPosition = signal({ top: 0, left: 0 });
  showEditInvoiceForm = signal(false);
  editingInvoice = signal<Invoice | null>(null);
  editInvoiceForm = this.emptyEditInvoice();
  accountView = signal(false);
  preferencesView = signal(false);
  accountTab = signal<'personal' | 'password'>('personal');
  accountLoading = signal(false);
  accountSaving = signal(false);
  passwordSaving = signal(false);
  accountError = signal('');
  accountMessage = signal('');
  accountForm: AccountForm = { firstName: '', lastName: '', phone: '', email: '' };
  passwordForm: PasswordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };
  menuOpen = signal(false);
  supportOpen = signal(false);
  supportSending = signal(false);
  supportTicketNumber = signal('');
  supportForm = { category: 'Invoice or balance', subject: '', message: '' };
  supportTickets = signal<SupportTicket[]>([]);
  supportTicketsLoading = signal(false);
  supportTicketSearch = signal('');
  supportTicketStatusFilter = signal<'all' | SupportTicketStatus>('all');
  supportTicketClientFilter = signal<string[]>([]);
  supportTicketClientFilterOpen = signal(false);
  selectedSupportTicket = signal<SupportTicket | null>(null);
  supportConversationTicket = signal<SupportTicket | null>(null);
  supportReplyText = signal('');
  supportReplySending = signal(false);
  supportNotificationLoading = signal(false);
  notifications = signal<PortalNotification[]>([]);
  notificationOpen = signal(false);
  toast = signal('');
  loading = signal(false);
  pdfReading = signal(false);
  pdfError = signal('');
  pdfViewerOpen = signal(false);
  pdfViewerLoading = signal(false);
  pdfViewerRawUrl = signal('');
  pdfViewerUrl = signal<SafeResourceUrl | null>(null);
  pdfViewerTitle = signal('');
  pdfViewerSubtitle = signal('');
  pdfViewerFileName = signal('document.pdf');
  pdfViewerError = signal('');
  private readonly pdfBlobCache = new Map<string, string>();
  private readonly pdfBlobLoading = new Map<string, Promise<string>>();
  invoicePdfFile: File | null = null;
  receivingPdfFile: File | null = null;
  newInvoice = this.emptyInvoice();
  showMobileSidebar = signal(false);

  // --- Dashboard Computed Properties ---
  clientTotalBalance = computed(() => {
    return this.invoices().reduce((sum, inv) => inv.status !== 'Pagada' ? sum + inv.amount : sum, 0);
  });
  clientPendingCount = computed(() => {
    return this.invoices().filter(inv => inv.status === 'Pendiente').length;
  });
  clientOverdueCount = computed(() => {
    return this.invoices().filter(inv => inv.status === 'Vencida').length;
  });

  filteredClientUsers = computed(() => {
    const query = this.search().trim().toLowerCase();
    return this.clients().filter(client => !query || `${client.name} ${client.username} ${client.email}`.toLowerCase().includes(query));
  });
  filteredClientPermissionOptions = computed(() => {
    const query = this.clientPermissionSearch().trim().toLowerCase();
    return this.customerOptions().filter(option => !query || option.toLowerCase().includes(query));
  });
  selectedClientPermissionCount = computed(() => this.clientForm.assignedClients.length);
  supportTicketClients = computed(() => Array.from(new Set(this.supportTickets().map(ticket => this.customerDisplayName(ticket.clientKey || ticket.userName)).filter(Boolean))).sort((a, b) => a.localeCompare(b)));
  openSupportTicketCount = computed(() => this.supportTickets().filter(ticket => ticket.status !== 'resolved').length);
  unreadNotificationCount = computed(() => this.notifications().filter(notification => !notification.read).length);
  filteredSupportTickets = computed(() => {
    const query = this.supportTicketSearch().trim().toLowerCase();
    const globalQuery = this.search().trim().toLowerCase();
    const status = this.supportTicketStatusFilter();
    const clients = this.supportTicketClientFilter();
    return this.supportTickets().filter(ticket => {
      const matchesQuery = !query || `${ticket.number} ${ticket.subject} ${ticket.message} ${ticket.userName} ${ticket.email}`.toLowerCase().includes(query);
      const matchesGlobalQuery = !globalQuery || `${ticket.number} ${ticket.subject} ${ticket.message} ${ticket.userName} ${ticket.email} ${ticket.clientKey || ''}`.toLowerCase().includes(globalQuery);
      const matchesStatus = status === 'all' || ticket.status === status;
       const matchesClient = !clients.length || clients.some(client => this.customerMatches(ticket.clientKey || ticket.userName, client));
      return matchesQuery && matchesGlobalQuery && matchesStatus && matchesClient;
    });
  });


  @HostListener('document:click', ['$event'])
  closeAccountMenuOnOutsideClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.reconciliation-filter-header')) this.reconciliationHeaderFilter.set(null);
    if (!target?.closest('.credit-report-customer-header')) this.creditReportCustomerFilterOpen.set(false);
    if (!target?.closest('.credit-report-customer-header')) this.creditReportCustomerFilterOpen.set(false);
    if (!target?.closest('.checks-tool-wrap') && !target?.closest('.cd-tool-wrap')) { this.checksDateMenuOpen.set(false); this.checksExportMenuOpen.set(false); }
    if (!target?.closest('.account-statement-customer-filter')) this.statementCustomerFilterOpen.set(false);
    if (!target?.closest('.invoice-customer-filter')) this.customerFilterOpen.set(false);
    if (!target?.closest('.credit-report-customer-header')) this.creditReportCustomerFilterOpen.set(false);
    if (!target?.closest('.support-ticket-client-filter')) this.supportTicketClientFilterOpen.set(false);
    if (!target?.closest('.portal-account-menu-anchor')) this.menuOpen.set(false);
    if (!target?.closest('.portal-notification-anchor')) this.notificationOpen.set(false);
    if (!target?.closest('.portal-invoice-actions-menu') && !target?.closest('.portal-invoice-actions-menu-button')) this.invoiceActionTarget.set(null);
    const actionButton = target?.closest('.portal-invoice-actions-menu-button') as HTMLElement | null;
    if (actionButton && this.invoiceActionTarget()) {
      const rect = actionButton.getBoundingClientRect();
      this.invoiceActionMenuPosition.set({ top: rect.bottom + 6, left: Math.max(12, rect.right - 248) });
    }
  }

  invoices = signal<Invoice[]>([]);

  customerOptions = computed(() => Array.from(new Set(this.invoices().map(invoice => this.customerDisplayName(invoice.client)).filter(Boolean))).sort((a, b) => a.localeCompare(b)));

  invoiceCustomerOptions = computed(() => {
    const current = this.user();
    const queryTerms = this.normalizeInvoiceSearch(this.search()).split(' ').filter(Boolean);
    const clients = this.invoices().filter(invoice => {
      const allowed = this.invoiceVisibleToUser(invoice, current);
      const receiving = this.statusFilter() === 'all'
        || (this.statusFilter() === 'withReceiving' && this.hasReceiving(invoice))
        || (this.statusFilter() === 'withoutReceiving' && !this.hasReceiving(invoice));
      const from = !this.dateFrom() || invoice.issued >= this.dateFrom();
      const to = !this.dateTo() || invoice.issued <= this.dateTo();
      const text = this.normalizeInvoiceSearch(`${invoice.folio} ${invoice.poNumber || ''} ${invoice.guideNumber || ''} ${invoice.client} ${invoice.concept} ${invoice.searchText || ''} ${invoice.amount}`);
      return allowed && receiving && from && to && (!queryTerms.length || queryTerms.every(term => text.includes(term)));
    }).map(invoice => this.invoiceFilterCustomerName(invoice.client)).filter(Boolean);
    return Array.from(new Set(clients)).sort((a, b) => a.localeCompare(b));
  });

  filteredInvoices = computed(() => {
    const current = this.user();
    const queryTerms = this.normalizeInvoiceSearch(this.invoiceSearch()).split(' ').filter(Boolean);
    const globalTerms = this.normalizeInvoiceSearch(this.search()).split(' ').filter(Boolean);
    const view = this.invoiceView();
    const searchField = this.invoiceSearchField();
    return this.invoices().filter(invoice => {
      const allowed = this.invoiceVisibleToUser(invoice, current);
      const receiving = this.statusFilter() === 'all'
        || (this.statusFilter() === 'withReceiving' && this.hasReceiving(invoice))
        || (this.statusFilter() === 'withoutReceiving' && !this.hasReceiving(invoice));
      // Se compara contra la etiqueta visible: una factura "Pendiente" con
      // recibimiento se muestra como "Received", y debe filtrarse como tal.
      const etiqueta = this.statusLabel(invoice);
      const matchesView = view === 'all'
        || (view === 'pending' && etiqueta === this.t('pending'))
        || (view === 'received' && etiqueta === this.t('received'))
        || (view === 'paid' && etiqueta === this.t('paid'))
        || (view === 'overdue' && etiqueta === this.t('overdue'))
        || (view === 'returns' && this.invoiceReturns(invoice).length > 0);
    const selectedCustomers = this.customerFilter();
      const customer = !selectedCustomers.length || selectedCustomers.some(selected => this.customerMatches(invoice.client, selected));
      const from = !this.dateFrom() || invoice.issued >= this.dateFrom();
      const to = !this.dateTo() || invoice.issued <= this.dateTo();
      const textSource = searchField === 'client'
        ? invoice.client
        : searchField === 'concept'
          ? `${invoice.concept} ${invoice.searchText || ''}`
          : `${invoice.folio} ${invoice.poNumber || ''} ${invoice.guideNumber || ''}`;
      const text = this.normalizeInvoiceSearch(textSource);
      const textoCompleto = this.normalizeInvoiceSearch(`${invoice.folio} ${invoice.poNumber || ''} ${invoice.guideNumber || ''} ${invoice.client} ${invoice.concept} ${invoice.searchText || ''}`);
      return allowed && matchesView && receiving && customer && from && to
        && (!queryTerms.length || queryTerms.every(term => text.includes(term)))
        && (!globalTerms.length || globalTerms.every(term => textoCompleto.includes(term)));
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

  invoiceFilterChips = computed(() => {
    const chips: Array<{ key: string; label: string }> = [];
    if (this.invoiceView() !== 'all') {
      const labels: Record<InvoiceView, string> = {
        all: '',
        pending: this.language() === 'es' ? 'Pendientes' : 'Pending',
        received: this.language() === 'es' ? 'Recibidas' : 'Received',
        paid: this.language() === 'es' ? 'Pagadas' : 'Paid',
        overdue: this.language() === 'es' ? 'Vencidas' : 'Overdue',
        returns: this.language() === 'es' ? 'Con crédito' : 'With credit',
      };
      chips.push({ key: 'view', label: labels[this.invoiceView()] });
    }
    if (this.statusFilter() !== 'all') {
      chips.push({ key: 'receiving', label: this.statusFilter() === 'withReceiving'
        ? (this.language() === 'es' ? 'Con recibimiento' : 'With receiving')
        : (this.language() === 'es' ? 'Sin recibimiento' : 'Without receiving') });
    }
    this.customerFilter().forEach(customer => chips.push({ key: `customer:${customer}`, label: customer }));
    // Las fechas no llevan chip: ya se ven en sus propios campos, igual que en Orders.
    return chips;
  });

  /**
   * Si hay algo filtrando la tabla, venga de donde venga. Las fechas
   * quedan fuera a proposito: se ven en sus propios campos y casi
   * siempre traen un rango puesto, asi que marcarian el embudo siempre.
   */
  invoiceFiltersApplied = computed(() =>
    this.invoiceFilterChips().length > 0
    || this.invoiceSearch().trim().length > 0
    || this.search().trim().length > 0);

  // ── Dashboard: resumen de transacciones ──
  dashboardYear = signal(new Date().getFullYear());

  dashboardYears = computed(() => {
    const years = new Set<number>();
    this.invoices().forEach(inv => {
      const y = parseInt(String(inv.issued || '').slice(0, 4), 10);
      if (!isNaN(y)) years.add(y);
    });
    years.add(new Date().getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  });

  dashboardHoverIndex = signal<number | null>(null);
  dashboardSearch = signal('');
  dashboardRowLimit = signal(15);
  dashboardCompactRows = signal(false);
  dashboardActionsOpen = signal(false);

  // Un dato por mes (0-11) del año seleccionado, respetando el rol (invoices() ya viene filtrado por usuario).
  dashboardMonthly = computed(() => {
    const year = this.dashboardYear();
    const months = Array.from({ length: 12 }, () => ({ count: 0, collected: 0, invoiced: 0, clients: new Set<string>() }));
    for (const inv of this.invoices()) {
      const issued = String(inv.issued || '');
      const y = parseInt(issued.slice(0, 4), 10);
      const m = parseInt(issued.slice(5, 7), 10) - 1;
      if (y !== year || m < 0 || m > 11) continue;
      const amount = Number(inv.amount || 0);
      const balance = this.invoiceBalance(inv);
      months[m].count += 1;
      months[m].invoiced += amount;
      months[m].collected += balance;
      if (inv.client) months[m].clients.add(inv.client);
    }
    return months.map(m => ({ count: m.count, collected: m.collected, invoiced: m.invoiced, clientCount: m.clients.size, topClient: this.monthTopClient(m.clients) }));
  });

  private monthTopClient(clients: Set<string>): string {
    if (clients.size === 0) return '';
    if (clients.size === 1) return Array.from(clients)[0];
    return `${clients.size} ${this.language() === 'es' ? 'clientes' : 'clients'}`;
  }

  dashboardTotalInvoiced = computed(() => this.dashboardMonthly().reduce((s, m) => s + m.invoiced, 0));
  dashboardTotalOps = computed(() => this.dashboardMonthly().reduce((s, m) => s + m.count, 0));

  // Agrupado por Cliente + Mes: total facturado de cada cliente en cada mes (ordenado cronológico).
  dashboardInvoiceRows = computed(() => {
    const year = this.dashboardYear();
    const queryTerms = this.normalizeInvoiceSearch(this.search()).split(' ').filter(Boolean);
    const groups = new Map<string, { client: string; monthIndex: number; amount: number; collected: number; count: number }>();
    for (const inv of this.invoices()) {
      const searchable = this.normalizeInvoiceSearch(`${inv.folio} ${inv.poNumber || ''} ${inv.guideNumber || ''} ${inv.client} ${inv.concept} ${inv.searchText || ''} ${inv.amount}`);
      if (queryTerms.length && !queryTerms.every(term => searchable.includes(term))) continue;
      const issued = String(inv.issued || '');
      if (parseInt(issued.slice(0, 4), 10) !== year) continue;
      const monthIndex = parseInt(issued.slice(5, 7), 10) - 1;
      if (monthIndex < 0 || monthIndex > 11) continue;
      const client = inv.client || '—';
      const key = `${monthIndex}::${client}`;
      const g = groups.get(key) || { client, monthIndex, amount: 0, collected: 0, count: 0 };
      g.amount += Number(inv.amount || 0);
      g.collected += this.invoiceBalance(inv);
      g.count += 1;
      groups.set(key, g);
    }
    return Array.from(groups.values()).sort((a, b) => a.monthIndex - b.monthIndex || b.amount - a.amount);
  });

  dashboardFilteredRows = computed(() => {
    const q = this.dashboardSearch().trim().toLowerCase();
    if (!q) return this.dashboardInvoiceRows();
    return this.dashboardInvoiceRows().filter(r =>
      r.client.toLowerCase().includes(q) || this.dashboardMonthName(r.monthIndex).toLowerCase().includes(q)
    );
  });

  dashboardFilteredTotal = computed(() => this.dashboardFilteredRows().reduce((s, r) => s + r.amount, 0));
  dashboardFilteredOutstandingBalance = computed(() => this.dashboardFilteredRows().reduce((s, r) => s + r.collected, 0));
  dashboardVisibleRows = computed(() => {
    const limit = this.dashboardRowLimit();
    return limit > 0 ? this.dashboardFilteredRows().slice(0, limit) : this.dashboardFilteredRows();
  });

  dashboardChartMonthly = computed(() => {
    const months = Array.from({ length: 12 }, () => ({ count: 0, invoiced: 0, collected: 0 }));
    this.dashboardFilteredRows().forEach(row => {
      months[row.monthIndex].count += row.count;
      months[row.monthIndex].invoiced += row.amount;
      months[row.monthIndex].collected += row.collected;
    });
    return months;
  });

  private dashboardFallbackPath(values: number[]) {
    const max = Math.max(1, ...values, ...this.dashboardChartMonthly().map(month => month.invoiced));
    const left = 42, right = 1180, top = 18, bottom = 260;
    const step = (right - left) / 11;
    const points = values.map((value, index) => ({ x: left + index * step, y: bottom - (value / max) * (bottom - top) }));
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1], current = points[index], control = (previous.x + current.x) / 2;
      path += ` C ${control} ${previous.y}, ${control} ${current.y}, ${current.x} ${current.y}`;
    }
    return path;
  }

  dashboardFallbackAreaPath() {
    return this.dashboardFallbackPath(this.dashboardChartMonthly().map(month => month.invoiced));
  }

  dashboardFallbackCollectedPath() {
    return this.dashboardFallbackPath(this.dashboardChartMonthly().map(month => month.collected));
  }

  dashboardFallbackAreaFill() {
    return `${this.dashboardFallbackAreaPath()} L 1180 260 L 42 260 Z`;
  }

  private updateDashboardChart() {
    const canvas = this.dashboardCanvasElement
      || document.querySelector<HTMLCanvasElement>('#dashboard-chart-canvas');
    if (canvas && !this.dashboardCanvasElement) this.dashboardCanvasElement = canvas;
    if (!canvas || this.activeTab() !== 'dashboard') {
      this.destroyDashboardChart();
      return;
    }

    const monthly = this.dashboardChartMonthly();
    const labels = monthly.map((_, index) => this.dashboardMonthName(index).slice(0, 3));
    const invoicedLabel = this.language() === 'es' ? 'Facturado' : 'Invoiced';
    const outstandingBalanceLabel = this.language() === 'es' ? 'Saldo pendiente' : 'Outstanding Balance';
    const data = {
      labels,
      datasets: [
        {
          label: invoicedLabel,
          data: monthly.map(month => month.invoiced),
          borderColor: '#087f8c',
          backgroundColor: 'rgba(8, 127, 140, 0.14)',
          pointBackgroundColor: '#fff',
          pointBorderColor: '#087f8c',
          pointBorderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2.5,
          tension: 0.35,
          fill: true
        },
        {
          label: outstandingBalanceLabel,
          data: monthly.map(month => month.collected),
          borderColor: '#d49a2f',
          backgroundColor: 'rgba(212, 154, 47, 0.05)',
          pointBackgroundColor: '#fff',
          pointBorderColor: '#d49a2f',
          pointBorderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          tension: 0.35,
          fill: false
        }
      ]
    };

    if (this.dashboardChart) {
      this.dashboardChart.data = data;
      this.dashboardChart.options.plugins!.legend!.labels!.font = { family: 'Nunito Sans', size: 11, weight: 600 };
      this.dashboardChart.update('none');
      this.dashboardChartReady.set(true);
      return;
    }

    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('El canvas del Dashboard no tiene contexto 2D disponible.');
      this.dashboardChart = new Chart(context, {
      type: 'line',
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 8, right: 10, left: 4, bottom: 0 } },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              usePointStyle: true,
              pointStyle: 'circle',
              boxWidth: 8,
              boxHeight: 8,
              padding: 16,
              color: '#53636c',
              font: { family: 'Nunito Sans', size: 11, weight: 600 }
            }
          },
          tooltip: {
            backgroundColor: '#17324a',
            borderColor: 'rgba(255,255,255,.14)',
            borderWidth: 1,
            titleColor: '#f6c453',
            bodyColor: '#fff',
            padding: 10,
            displayColors: true,
            callbacks: {
              title: items => `${items[0]?.label || ''} · ${this.dashboardYear()}`,
              label: item => ` ${item.dataset.label}: ${this.formatMoney(Number(item.raw || 0))}`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: '#8b949c', font: { family: 'Nunito Sans', size: 10, weight: 500 } }
          },
          y: {
            beginAtZero: true,
            border: { display: false },
            grid: { color: '#edf1f0' },
            ticks: {
              color: '#8b949c',
              maxTicksLimit: 5,
              font: { family: 'Nunito Sans', size: 10 },
              callback: value => this.formatCompactMoney(Number(value))
            }
          }
        }
      }
      });
      this.dashboardChartReady.set(true);
    } catch (error) {
      console.error('No fue posible inicializar el gráfico Chart.js.', error);
      this.dashboardChartReady.set(false);
      this.dashboardChart = undefined;
    }
  }

  private destroyDashboardChart() {
    this.dashboardChart?.destroy();
    this.dashboardChart = undefined;
    this.dashboardChartReady.set(false);
  }

  // Coordenadas de cada punto para posicionar el tooltip / marcador.
  dashboardPoints(): { x: number; y: number; cx: number }[] {
    const data = this.dashboardChartMonthly().map(m => m.invoiced);
    const max = this.dashboardMaxInvoiced();
    const W = 1000, H = 300, pad = 10;
    const stepX = (W - pad * 2) / 11;
    return data.map((v, i) => ({ x: pad + i * stepX, y: H - pad - (v / max) * (H - pad * 2), cx: ((pad + i * stepX) / W) * 100 }));
  }

  onDashboardMove(event: MouseEvent, el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const idx = Math.round(ratio * 11);
    this.dashboardHoverIndex.set(Math.max(0, Math.min(11, idx)));
  }

  dashboardMaxInvoiced = computed(() => Math.max(1, ...this.dashboardMonthly().map(m => m.invoiced)));

  dashboardTotalCollected = computed(() => this.dashboardMonthly().reduce((s, m) => s + m.collected, 0));

  // Genera el path SVG suave del área (spline simple) sobre 12 puntos.
  dashboardAreaPath(): string {
    const data = this.dashboardChartMonthly().map(m => m.invoiced);
    const max = this.dashboardMaxInvoiced();
    const W = 1000, H = 300, pad = 10;
    const stepX = (W - pad * 2) / 11;
    const pts = data.map((v, i) => ({ x: pad + i * stepX, y: H - pad - (v / max) * (H - pad * 2) }));
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1], cur = pts[i];
      const cx = (prev.x + cur.x) / 2;
      d += ` C ${cx} ${prev.y}, ${cx} ${cur.y}, ${cur.x} ${cur.y}`;
    }
    return d;
  }

  dashboardAreaFill(): string {
    const line = this.dashboardAreaPath();
    return `${line} L 990 290 L 10 290 Z`;
  }

  dashboardMonthName(index: number): string {
    const es = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const en = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return (this.language() === 'es' ? es : en)[index];
  }

  resetDashboardFilters() {
    this.dashboardSearch.set('');
    this.dashboardActionsOpen.set(false);
  }

  exportDashboardCsv() {
    const rows = this.dashboardFilteredRows();
    const escapeCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const headers = this.language() === 'es' ? ['Cliente', 'Mes', 'Operaciones', 'Monto'] : ['Customer', 'Month', 'Operations', 'Amount'];
    const csvRows = [headers.map(escapeCell).join(',')];
    rows.forEach(row => csvRows.push([
      row.client,
      this.dashboardMonthName(row.monthIndex),
      row.count,
      row.amount.toFixed(2)
    ].map(escapeCell).join(',')));
    const blob = new Blob([`\uFEFF${csvRows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `dashboard-${this.dashboardYear()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.dashboardActionsOpen.set(false);
  }

  total = computed(() => this.filteredInvoices().reduce((sum, item) => sum + item.amount, 0));
  pending = computed(() => this.filteredInvoices().filter(item => item.status !== 'Pagada').reduce((sum, item) => sum + item.amount, 0));
  paid = computed(() => this.filteredInvoices().filter(item => item.status === 'Pagada').reduce((sum, item) => sum + item.amount, 0));
  accountStatementInvoices = computed(() => {
    const customers = this.statementCustomerFilter();
    const queryTerms = this.normalizeInvoiceSearch(this.search()).split(' ').filter(Boolean);
    return [...this.invoices()]
      .filter(invoice => {
        const text = this.normalizeInvoiceSearch(`${invoice.folio} ${invoice.poNumber || ''} ${invoice.guideNumber || ''} ${invoice.client} ${invoice.concept} ${invoice.searchText || ''} ${invoice.amount}`);
        const matchesSearch = !queryTerms.length || queryTerms.every(term => text.includes(term));
        const company = this.statementCompany();
        if (company !== 'all' && this.invoiceIssuerKey(invoice) !== company) return false;
        const agent = this.statementAgent();
        if (agent && !this.agentCoversInvoice(agent, invoice)) return false;
        const issued = String(invoice.issued || '').slice(0, 10);
        const from = this.statementDateFrom();
        const to = this.statementDateTo();
        if (from && issued && issued < from) return false;
        if (to && issued && issued > to) return false;
        return this.accountStatementBalance(invoice) > 0
          && this.accountStatementCustomerMatches(invoice, customers)
          && matchesSearch;
      })
      .sort((a, b) => String(b.issued || '').localeCompare(String(a.issued || '')) || String(a.folio).localeCompare(String(b.folio), undefined, { numeric: true }));
  });
  /** Clientes distintos que este usuario puede ver, sin contar filtros. */
  statementCustomerUniverse = computed(() => {
    const current = this.user();
    const keys = new Set<string>();
    for (const invoice of this.invoices()) {
      if (!this.invoiceVisibleToUser(invoice, current)) continue;
      if (this.accountStatementBalance(invoice) <= 0) continue;
      keys.add(this.accountStatementCustomerGroupKey(invoice));
    }
    return keys.size;
  });

  /** Con un solo cliente, elegir empresa o cliente no cambia nada. */
  statementShowScopeFilters = computed(() => this.statementCustomerUniverse() > 1);

  accountStatementCustomers = computed(() => {
    const customers = new Map<string, string>();
    const company = this.statementCompany();
    const agent = this.statementAgent();
    for (const invoice of this.invoices()) {
      if (this.accountStatementBalance(invoice) <= 0) continue;
      if (company !== 'all' && this.invoiceIssuerKey(invoice) !== company) continue;
      if (agent && !this.agentCoversInvoice(agent, invoice)) continue;
      const key = this.accountStatementCustomerGroupKey(invoice);
      customers.set(key, this.accountStatementCustomerDisplayName(invoice));
    }
    return Array.from(customers.values()).sort((a, b) => a.localeCompare(b));
  });
  accountStatementTotals = computed(() => {
    const invoices = this.accountStatementInvoices();
    return {
      invoices: invoices.length,
      invoiced: invoices.reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0),
      credits: invoices.reduce((sum, invoice) => sum + Number(invoice.creditAmount || 0), 0),
      balance: invoices.reduce((sum, invoice) => sum + this.accountStatementBalance(invoice), 0)
    };
  });
  accountStatementGroups = computed<AccountStatementCustomerGroup[]>(() => {
    const groups = new Map<string, AccountStatementCustomerGroup>();
    for (const invoice of this.accountStatementInvoices()) {
      const row = this.accountStatementAgingRow(invoice);
       const groupKey = this.accountStatementCustomerGroupKey(invoice);
       let group = groups.get(groupKey);
       if (!group) {
         group = {
           customerCode: groupKey === 'we-got-flowers' ? groupKey : (invoice.clientKey || invoice.client || ''),
           customerName: this.accountStatementCustomerDisplayName(invoice),
           rows: [],
           totals: { '0': 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0, balance: 0 }
         };
        groups.set(groupKey, group);
      }
      group.rows.push(row);
      group.totals[row.agingBucket] += row.balance;
      group.totals.balance += row.balance;
    }
    for (const group of groups.values()) {
      group.rows.sort((a, b) => this.compareAccountStatementRows(a, b));
    }
    return Array.from(groups.values()).sort((a, b) => a.customerName.localeCompare(b.customerName));
  });
  accountStatementSummaryTotals = computed(() => {
    return this.accountStatementGroups().reduce((sum, group) => ({
      '0': sum['0'] + group.totals['0'],
      '1-30': sum['1-30'] + group.totals['1-30'],
      '31-60': sum['31-60'] + group.totals['31-60'],
      '61-90': sum['61-90'] + group.totals['61-90'],
      '90+': sum['90+'] + group.totals['90+'],
      balance: sum.balance + group.totals.balance
    }), { '0': 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0, balance: 0 });
  });
  accountStatementSummaryGrandTotals = computed(() => {
    return this.accountStatementGroups().reduce((sum, group) => {
      const divisor = group.rows.length && this.isWalmexInvoice(group.rows[0].invoice) ? 17.5 : 1;
      return {
        '0': sum['0'] + group.totals['0'] / divisor,
        '1-30': sum['1-30'] + group.totals['1-30'] / divisor,
        '31-60': sum['31-60'] + group.totals['31-60'] / divisor,
        '61-90': sum['61-90'] + group.totals['61-90'] / divisor,
        '90+': sum['90+'] + group.totals['90+'] / divisor,
        balance: sum.balance + group.totals.balance / divisor
      };
    }, { '0': 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0, balance: 0 });
  });
  accountStatementSummaryRows = computed(() => {
    return [...this.accountStatementGroups()]
      .sort((a, b) => b.totals.balance - a.totals.balance)
      .map(group => ({ group }));
  });
  creditReportRows = computed(() => {
    const selectedCustomers = this.creditReportCustomerFilter();
    const queryTerms = this.normalizeInvoiceSearch(this.search()).split(' ').filter(Boolean);
    return this.invoices().flatMap(invoice => (invoice.credits || []).map(credit => ({ invoice, credit })))
      .filter(row => {
        const searchable = this.normalizeInvoiceSearch(`${row.invoice.folio} ${row.invoice.poNumber || ''} ${row.invoice.guideNumber || ''} ${row.invoice.client} ${row.invoice.concept} ${row.invoice.searchText || ''} ${row.credit.creditNumber} ${row.credit.guideNumber || ''}`);
        return (!selectedCustomers.length || selectedCustomers.some(selected => this.customerMatches(row.invoice.client, selected)))
          && (!queryTerms.length || queryTerms.every(term => searchable.includes(term)));
      })
      .sort((a, b) => String(b.credit.date || b.credit.dateProcessed || '').localeCompare(String(a.credit.date || a.credit.dateProcessed || '')));
  });
  creditReportTotals = computed(() => {
    const rows = this.creditReportRows();
    return { credits: rows.length, amount: rows.reduce((sum, row) => sum + Number(row.credit.amount || 0), 0), invoices: new Set(rows.map(row => row.invoice.id)).size };
  });
  creditReportCustomers = computed(() => Array.from(new Set(this.invoices().filter(invoice => (invoice.credits || []).length).map(invoice => this.customerDisplayName(invoice.client)))).sort((a, b) => a.localeCompare(b)));
  checkInvoices = computed(() => {
    const queryTerms = this.normalizeInvoiceSearch(this.search()).split(' ').filter(Boolean);
    return this.invoices()
    .filter(invoice => {
      const searchable = this.normalizeInvoiceSearch(`${invoice.folio} ${invoice.poNumber || ''} ${invoice.guideNumber || ''} ${invoice.client} ${invoice.concept} ${invoice.searchText || ''} ${invoice.amount}`);
      return this.checkClient() && this.checkCustomerMatches(invoice.client, this.checkClient())
        && this.invoiceBalance(invoice) > 0
        && (!queryTerms.length || queryTerms.every(term => searchable.includes(term)));
    })
    .sort((a, b) => String(a.due || a.issued).localeCompare(String(b.due || b.issued)));
  });
  checkCustomerOptions = computed(() => Array.from(new Set(this.invoices()
    .filter(invoice => this.invoiceBalance(invoice) > 0)
    .map(invoice => this.customerDisplayName(invoice.client))
    .filter(Boolean))).sort((a, b) => a.localeCompare(b)));
  checkSelectedBalance = computed(() => {
    const amounts = this.checkInvoiceAmounts();
    return this.selectedCheckInvoiceIds().reduce<number>((sum, id) => sum + (Number(amounts[String(id)]) || 0), 0);
  });
  checkUnallocated = computed(() => Math.max(0, Number(this.checkTotal() || 0) - this.checkSelectedBalance()));
  checkOverAllocated = computed(() => Math.max(0, Number((this.checkSelectedBalance() - Number(this.checkTotal() || 0)).toFixed(2))));
  checkRequiredFieldsComplete = computed(() => Boolean(this.checkSeries().trim() && this.checkClient() && Number(this.checkTotal()) > 0));

  filteredReconciliationRows = computed(() => {
    const query = this.search().trim().toLowerCase();
    const rows = this.reconciliationRows().filter(row => {
      const from = !this.reconciliationDateFrom() || row.date >= this.reconciliationDateFrom();
      const to = !this.reconciliationDateTo() || row.date <= this.reconciliationDateTo();
      const text = `${row.folio} ${row.series || ''} ${row.client} ${row.total}`.toLowerCase();
      const folioFilter = !this.reconciliationFolioFilter() || row.folio.toLowerCase().includes(this.reconciliationFolioFilter().trim().toLowerCase());
      const seriesFilter = !this.reconciliationSeriesFilter() || row.series.toLowerCase().includes(this.reconciliationSeriesFilter().trim().toLowerCase());
      const clientFilter = this.customerQueryMatches(row.client, this.reconciliationClientFilter());
      const resultFilter = this.reconciliationResultFilter() === 'all' || row.sourceStatus === this.reconciliationResultFilter();
      const validationFilter = this.reconciliationValidationFilter() === 'all'
        || (this.reconciliationValidationFilter() === 'duplicate' && row.validation.includes('duplicate'))
        || (this.reconciliationValidationFilter() === 'amount-different' && row.validation === 'amount-different')
        || (this.reconciliationValidationFilter() === 'missing' && row.validation === 'missing')
        || (this.reconciliationValidationFilter() === 'live-invoice' && row.validation === 'live-invoice')
        || (this.reconciliationValidationFilter() === 'valid' && row.validation === 'valid');
      return from && to && folioFilter && seriesFilter && clientFilter && resultFilter && validationFilter && (!query || text.includes(query));
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
  reconciliationAmountTotal = computed(() => this.filteredReconciliationRows().reduce((sum, row) => sum + (Number.isFinite(row.total) ? row.total : 0), 0));
  reconciliationSystemBalanceTotal = computed(() => this.filteredReconciliationRows().reduce((sum, row) => sum + (row.balanceSystem !== null && Number.isFinite(row.balanceSystem) ? row.balanceSystem : 0), 0));
  reconciliationContPaqBalanceTotal = computed(() => this.filteredReconciliationRows().reduce((sum, row) => sum + (row.balanceContPaq !== null && Number.isFinite(row.balanceContPaq) ? row.balanceContPaq : 0), 0));

  filteredCreditReconciliationRows = computed(() => {
    const query = this.search().trim().toLowerCase();
    const po = this.creditReconciliationPoFilter().trim().toLowerCase();
    const folio = this.creditReconciliationFolioFilter().trim().toLowerCase();
    const client = this.creditReconciliationClientFilter().trim().toLowerCase();
    const date = this.creditReconciliationDateFilter().trim().toLowerCase();
    const validation = this.creditReconciliationValidationFilter();

    return this.creditReconciliationRows().filter(row => {
      const searchable = `${row.po} ${row.folios} ${row.client} ${row.date} ${row.agent}`.toLowerCase();
      return (!query || searchable.includes(query))
        && (!po || row.po.toLowerCase().includes(po))
        && (!folio || row.folios.toLowerCase().includes(folio))
        && this.customerQueryMatches(row.client, client)
        && (!date || row.date.toLowerCase().includes(date))
        && (validation === 'all' || row.validation === validation);
    });
  });

  reconciliationValidationLabel(row: ReconciliationRow) {
    const labels = this.language() === 'es'
      ? { valid: 'Correcta', 'amount-different': 'Monto diferente', missing: 'Faltante', 'live-invoice': 'Factura viva', 'excel-duplicate': 'Duplicada en Excel', 'system-duplicate': 'Duplicada en sistema', 'both-duplicate': 'Duplicada en ambos' }
      : { valid: 'Valid', 'amount-different': 'Amount different', missing: 'Missing', 'live-invoice': 'Live invoice', 'excel-duplicate': 'Duplicate in Excel', 'system-duplicate': 'Duplicate in system', 'both-duplicate': 'Duplicate in both' };
    return labels[row.validation];
  }

  toggleReconciliationHeaderFilter(key: ReconciliationFilterKey, event: MouseEvent) {
    event.stopPropagation();
    this.reconciliationHeaderFilter.set(this.reconciliationHeaderFilter() === key ? null : key);
  }

  toggleCreditReconciliationHeaderFilter(key: CreditReconciliationFilterKey, event: MouseEvent) {
    event.stopPropagation();
    this.creditReconciliationHeaderFilter.set(this.creditReconciliationHeaderFilter() === key ? null : key);
  }

  closeReconciliationHeaderFilter() {
    this.reconciliationHeaderFilter.set(null);
  }

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
    const table = document.querySelector('.client-invoice-table');
    table?.setAttribute('data-sort-key', key);
    table?.setAttribute('data-sort-direction', this.invoiceSortDirection());
  }

  setInvoiceView(value: InvoiceView) {
    this.invoiceView.set(value);
    this.invoicePage.set(1);
  }

  setInvoiceSearchField(value: InvoiceSearchField) {
    this.invoiceSearchField.set(value);
    this.invoicePage.set(1);
  }

  toggleInvoiceFilter() {
    this.invoiceFilterOpen.update(value => !value);
  }

  toggleInvoiceColumnChooser() {
    this.invoiceColumnChooserOpen.update(value => !value);
  }

  invoiceSearchPlaceholder() {
    if (this.invoiceSearchField() === 'client') return this.language() === 'es' ? 'Buscar cliente' : 'Search customer';
    if (this.invoiceSearchField() === 'concept') return this.language() === 'es' ? 'Buscar descripción' : 'Search description';
    return this.language() === 'es' ? 'Buscar por número' : 'Search by number';
  }

  invoiceColumnVisible(key: InvoiceGridColumn['key']) {
    return this.invoiceColumns().some(column => column.key === key && column.visible);
  }

  /* --- soporte para el grid de PrimeNG, calcado del de Orders --- */

  visibleInvoiceColumns = computed(() => this.invoiceColumns().filter(column => column.visible));

  /** ¿El resultado filtrado trae al menos una devolución? */
  private filteredHasReturns = computed(() => this.filteredInvoices().some(invoice => this.invoiceReturns(invoice).length > 0));

  /** Columnas en pantalla: se quita Devolución cuando el resultado no tiene. */
  displayedInvoiceColumns = computed(() =>
    this.visibleInvoiceColumns().filter(column => column.key !== 'devolucion' || this.filteredHasReturns()));

  /** Una columna queda congelada si sigue entre las tres primeras. */
  isInvoiceColumnFrozen(column: InvoiceGridColumn) {
    return this.invoiceColumns().slice(0, this.invoiceFrozenCount).some(item => item.key === column.key);
  }

  /** Desplazamiento acumulado para el `position: sticky` de las congeladas. */
  invoiceFrozenLeft(column: InvoiceGridColumn) {
    let left = 0;
    for (const item of this.visibleInvoiceColumns()) {
      if (item.key === column.key) break;
      if (this.isInvoiceColumnFrozen(item)) left += item.width;
    }
    return left;
  }

  /* --- fechas del filtro con el calendario de PrimeNG --- */

  /** Las fechas se guardan como 'yyyy-mm-dd'; el calendario trabaja con Date. */
  private toDateValue(value: string): Date | null {
    if (!value) return null;
    const [year, month, day] = value.split('-').map(Number);
    return Number.isFinite(year) ? new Date(year, (month || 1) - 1, day || 1) : null;
  }

  private fromDateValue(value: Date | null): string {
    if (!value) return '';
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }

  invoiceDateFromValue = computed(() => this.toDateValue(this.dateFrom()));
  invoiceDateToValue = computed(() => this.toDateValue(this.dateTo()));

  setInvoiceDateFrom(value: Date | null) {
    this.dateFrom.set(this.fromDateValue(value));
    this.onInvoiceDateRange();
  }

  setInvoiceDateTo(value: Date | null) {
    this.dateTo.set(this.fromDateValue(value));
    this.onInvoiceDateRange();
  }

  /** Ancho de la columna de acciones: sus botones llevan texto, no solo iconos. */
  readonly invoiceActionsWidth = 210;

  /** Opciones de los desplegables de la barra, como el "My View" de Orders. */
  invoiceViewOptions = computed(() => [
    { label: this.language() === 'es' ? 'Todas las facturas' : 'All invoices', value: 'all' },
    { label: this.t('pending'), value: 'pending' },
    { label: this.t('received'), value: 'received' },
    { label: this.t('paid'), value: 'paid' },
    { label: this.t('overdue'), value: 'overdue' },
    { label: this.language() === 'es' ? 'Con crédito' : 'With credit', value: 'returns' }
  ]);

  invoiceSearchFieldOptions = computed(() => [
    { label: this.language() === 'es' ? 'Factura / PO' : 'Invoice / PO number', value: 'number' },
    { label: this.t('customer'), value: 'client' },
    { label: this.language() === 'es' ? 'Concepto' : 'Description', value: 'concept' }
  ]);

  invoiceTableWidth = computed(() =>
    this.displayedInvoiceColumns().reduce((sum, column) => sum + column.width, 0) + this.invoiceActionsWidth);

  /** Etiqueta traducida de cada columna. */
  invoiceColumnLabel(column: InvoiceGridColumn) {
    const labels: Record<string, string> = {
      poNumber: this.t('poNumber'),
      guideNumber: 'AWB',
      devolucion: this.language() === 'es' ? 'Crédito' : 'Credit',
      folio: this.t('invoice'),
      client: this.t('customer'),
      issued: this.t('issued'),
      due: this.t('due'),
      amount: this.t('amountUsd'),
      balance: this.t('balance'),
      status: this.t('status')
    };
    return labels[column.key] || column.label;
  }

  invoiceVisibleColumnCount() {
    return this.invoiceColumns().filter(column => column.visible).length + 2;
  }

  toggleInvoiceColumn(key: InvoiceGridColumn['key']) {
    this.invoiceColumns.update(columns => columns.map(column =>
      column.key === key && !column.locked ? { ...column, visible: !column.visible } : column));
  }

  resetInvoiceColumns() {
    this.invoiceColumns.update(columns => columns.map(column => ({ ...column, visible: true })));
  }


  clearInvoiceTableFilters() {
    this.invoiceView.set('all');
    this.statusFilter.set('all');
    this.customerFilter.set([]);
    // Las fechas vuelven al rango completo, no a vacio.
    this.resetInvoiceDateRange();
    this.invoicePage.set(1);
  }

  /** Rango completo: de la factura mas antigua hasta hoy. */
  private resetInvoiceDateRange() {
    const fechas = this.invoices().map(invoice => invoice.issued).filter(Boolean).sort();
    this.dateFrom.set(fechas.length ? fechas[0] : '');
    this.dateTo.set(App.todayIso());
  }

  removeInvoiceFilterChip(chip: { key: string; label: string }) {
    if (chip.key === 'view') this.invoiceView.set('all');
    else if (chip.key === 'receiving') this.statusFilter.set('all');
    else if (chip.key === 'from') this.dateFrom.set('');
    else if (chip.key === 'to') this.dateTo.set('');
    else if (chip.key.startsWith('customer:')) {
      const customer = chip.key.slice('customer:'.length);
      this.customerFilter.set(this.customerFilter().filter(item => item !== customer));
    }
    this.invoicePage.set(1);
  }

  @HostListener('document:pointerdown', ['$event'])
  closeReconciliationFilterOnOutsidePointer(event: PointerEvent) {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.reconciliation-filter-header')) this.reconciliationHeaderFilter.set(null);
    if (!target?.closest('.credit-reconciliation-filter-header')) this.creditReconciliationHeaderFilter.set(null);
    if (!target?.closest('.credit-report-customer-header')) this.creditReportCustomerFilterOpen.set(false);
    if (!target?.closest('.credit-report-customer-header')) this.creditReportCustomerFilterOpen.set(false);
    if (!target?.closest('.checks-tool-wrap') && !target?.closest('.cd-tool-wrap')) { this.checksDateMenuOpen.set(false); this.checksExportMenuOpen.set(false); }
    if (!target?.closest('.account-statement-customer-filter')) this.statementCustomerFilterOpen.set(false);
    if (!target?.closest('.invoice-customer-filter')) this.customerFilterOpen.set(false);
    if (!target?.closest('.support-ticket-client-filter')) this.supportTicketClientFilterOpen.set(false);
  }

  @HostListener('document:click', ['$event'])
  sortInvoiceFromHeader(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    const header = target?.closest('.portal-table thead th') as HTMLTableCellElement | null;
    const table = header?.closest('.portal-table');
    if (table?.classList.contains('invoice-enhanced-table')) return;
    if (!header || !table || table.querySelectorAll('thead th').length < 8 || header.cellIndex >= 7) return;
    const keys: InvoiceSortKey[] = ['poNumber', 'guideNumber', 'folio', 'client', 'issued', 'due', 'amount', 'status'];
    this.sortInvoices(keys[header.cellIndex]);
  }

  invoicePageStart() {
    return this.filteredInvoices().length ? (this.invoicePage() - 1) * this.invoicePageSize() + 1 : 0;
  }

  invoicePageEnd() {
    return Math.min(this.invoicePage() * this.invoicePageSize(), this.filteredInvoices().length);
  }

  onInvoiceSearch(value: string) {
    this.invoiceSearch.set(value);
    this.invoicePage.set(1);
  }

  /** Buscador global de la barra superior; no toca el de la tabla. */
  onQuickSearch(value: string) {
    this.search.set(value);
    this.invoicePage.set(1);
  }

  private normalizeInvoiceSearch(value: string) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  onInvoiceStatus(value: 'all' | 'withReceiving' | 'withoutReceiving') {
    this.statusFilter.set(value);
    this.invoicePage.set(1);
  }

  onInvoiceCustomer(value: string) {
    if (value === 'all') {
      this.customerFilter.set([]);
    } else {
      const customer = this.customerDisplayName(value);
      const selected = this.customerFilter();
      this.customerFilter.set(selected.includes(customer)
        ? selected.filter(item => item !== customer)
        : [...selected, customer]);
    }
    this.invoicePage.set(1);
  }

  invoiceCustomerFilterLabel() {
    const selected = this.customerFilter();
    if (!selected.length) return this.language() === 'es' ? 'Todos los clientes' : 'All customers';
    if (selected.length === 1) return selected[0];
    return this.language() === 'es' ? `${selected.length} clientes seleccionados` : `${selected.length} customers selected`;
  }

  onInvoiceDateRange() {
    this.invoicePage.set(1);
  }

  toggleStatementCustomer(value: string) {
    if (value === 'all') {
      this.statementCustomerFilter.set([]);
      return;
    }
    const customer = this.customerDisplayName(value);
    const selected = this.statementCustomerFilter();
    this.statementCustomerFilter.set(selected.includes(customer)
      ? selected.filter(item => item !== customer)
      : [...selected, customer]);
  }

  get accountStatementView(): 'detailed' | 'summary' {
    return this.accountStatementViewMode();
  }
  set accountStatementView(value: 'detailed' | 'summary') {
    if (value) this.accountStatementViewMode.set(value);
  }

  // computed, no metodo: *ngFor de PrimeNG no usa trackBy, y un array nuevo en
  // cada ciclo recrea los botones entre mousedown y mouseup, matando el click.
  /**
   * Empresa que emite la factura. Se deduce del texto extraido del PDF:
   * las de Centro Floricultor lo llevan en el encabezado. El resto es
   * Pacifica, que es la emisora por omision.
   */
  invoiceIssuerKey(invoice: Invoice): 'pacifica' | 'centro' {
    if (invoice.walmexSource || invoice.clientKey === 'walmex') return 'centro';
    const text = ((invoice.searchText || '') + ' ' + (invoice.concept || '')).toLowerCase();
    return text.includes('centro floricultor') ? 'centro' : 'pacifica';
  }

  isWalmexInvoice(invoice: Invoice): boolean {
    return Boolean(invoice.walmexSource || invoice.clientKey === 'walmex');
  }

  walmexPesosToDollars(value: number): number {
    return Number((Number(value || 0) / 17.5).toFixed(2));
  }

  summaryDisplayAmount(group: AccountStatementCustomerGroup, bucket: AccountStatementAgingBucket | 'balance'): number {
    const amount = group.totals[bucket];
    return group.rows.length && this.isWalmexInvoice(group.rows[0].invoice) ? this.walmexPesosToDollars(amount) : amount;
  }

  issuerName(key: 'pacifica' | 'centro'): string {
    return key === 'centro' ? 'Centro Floricultor B.C' : 'Pacifica Produce LLC';
  }

  statementScopeOptions = computed(() => {
    const isSpanish = this.language() === 'es';
    const visible = this.statementVisibleCompanies();
    const groups: any[] = [
      {
        label: isSpanish ? 'Empresa' : 'Company',
        items: [
          ...(visible.length !== 1 ? [{ label: isSpanish ? 'Todas' : 'All', value: 'all' }] : []),
          ...(visible.includes('pacifica') ? [{ label: 'Pacifica Produce LLC', value: 'pacifica' }] : []),
          ...(visible.includes('centro') ? [{ label: 'Centro Floricultor B.C', value: 'centro' }] : [])
        ]
      }
    ];
    const agents = this.agents();
    if (agents.length) {
      groups.push({
        label: isSpanish ? 'Agente' : 'Agent',
        items: [...agents]
          .sort((a, b) => a.name.localeCompare(b.name, 'es'))
          .map(agent => ({ label: agent.name, value: 'agent:' + agent.id }))
      });
    }
    return groups;
  });

  /** Un agente cubre la factura si el cliente esta en su cartera. */
  agentCoversInvoice(agent: Agent, invoice: Invoice): boolean {
    return (agent.clients || []).some(client => this.customerMatches(invoice.client || '', client)
      || this.customerMatches(invoice.clientKey || '', client));
  }

  /** Agente que lleva a un cliente, buscando por su nombre visible. */
  agentForCustomerName(customerName: string): Agent | null {
    if (!customerName) return null;
    return this.agents().find(agent => (agent.clients || [])
      .some(client => this.customerMatches(customerName, client))) || null;
  }

  get statementScopeValue(): string {
    return this.statementCompany();
  }
  set statementScopeValue(value: string) {
    if (!value || value === this.statementScope()) return;
    this.statementScope.set(value);
    // los clientes seleccionados pueden no existir en el nuevo ambito
    this.statementCustomerFilter.set([]);
  }

  statementHeaderCompany(): string {
    const company = this.statementCompany();
    // con una sola empresa cabe el nombre completo; con las dos se abrevia
    if (company === 'all') return 'PPF · CFBC';
    return this.issuerName(company);
  }

  /**
   * Empresa de un grupo de clientes. Se decide por el saldo, no por la
   * primera factura: un cliente puede tener documentos de ambas empresas
   * y la que concentra la deuda es la que debe firmar y enviar.
   */
  groupIssuerKey(group: { rows: any[] }): 'pacifica' | 'centro' {
    let centro = 0;
    let pacifica = 0;
    for (const row of group.rows || []) {
      const amount = Number(row.balance || 0);
      if (this.invoiceIssuerKey(row.invoice) === 'centro') centro += amount;
      else pacifica += amount;
    }
    return centro > pacifica ? 'centro' : 'pacifica';
  }

  groupIssuerName(group: { rows: any[] }): string {
    return group.rows?.length ? this.issuerName(this.groupIssuerKey(group)) : '';
  }

  statementDateRangeActive(): boolean {
    return !!(this.statementDateFrom() || this.statementDateTo());
  }

  clearStatementDateRange() {
    this.statementDateFrom.set('');
    this.statementDateTo.set('');
  }

  accountStatementViewOptions = computed(() => {
    const isSpanish = this.language() === 'es';
    return [
      { label: isSpanish ? 'Detallado' : 'Detailed', value: 'detailed' },
      { label: isSpanish ? 'Resumen' : 'Summary', value: 'summary' }
    ];
  });

  accountStatementCustomerPlaceholder() {
    return this.language() === 'es' ? 'Todos los clientes' : 'All customers';
  }

  statementCustomerFilterLabel() {
    const selected = this.statementCustomerFilter();
    if (!selected.length) return this.language() === 'es' ? 'Todos los clientes' : 'All customers';
    if (selected.length === 1) return selected[0];
    return this.language() === 'es' ? `${selected.length} clientes seleccionados` : `${selected.length} customers selected`;
  }

  setCreditReportCustomerFilter(value: string) {
    if (value === 'all') {
      this.creditReportCustomerFilter.set([]);
      return;
    }
    const customer = this.customerDisplayName(value);
    const selected = this.creditReportCustomerFilter();
    this.creditReportCustomerFilter.set(selected.includes(customer)
      ? selected.filter(item => item !== customer)
      : [...selected, customer]);
  }

  creditReportCustomerFilterLabel() {
    const selected = this.creditReportCustomerFilter();
    if (!selected.length) return this.language() === 'es' ? 'Todos los clientes' : 'All customers';
    if (selected.length === 1) return selected[0];
    return this.language() === 'es' ? `${selected.length} clientes seleccionados` : `${selected.length} customers selected`;
  }

  toggleSupportTicketClientFilter(value: string) {
    if (value === 'all') {
      this.supportTicketClientFilter.set([]);
      return;
    }
    const customer = this.formatCustomerDisplay(value);
    const selected = this.supportTicketClientFilter();
    this.supportTicketClientFilter.set(selected.includes(customer)
      ? selected.filter(item => item !== customer)
      : [...selected, customer]);
  }

  supportTicketClientFilterLabel() {
    const selected = this.supportTicketClientFilter();
    if (!selected.length) return this.language() === 'es' ? 'Todos los clientes' : 'All customers';
    if (selected.length === 1) return selected[0];
    return this.language() === 'es' ? `${selected.length} clientes seleccionados` : `${selected.length} customers selected`;
  }

  constructor() {
    const startupView = getPortalStartupView(window.location.href);
    this.activeTab.set(startupView.activeTab);
    this.reconciliationView.set(startupView.reconciliationView);
    if (startupView.url !== window.location.href) {
      window.history.replaceState({}, '', startupView.url);
    }
    effect(() => {
      this.activeTab();
      this.dashboardYear();
      this.dashboardSearch();
      this.dashboardChartMonthly();
      this.language();
      requestAnimationFrame(() => this.updateDashboardChart());
    });
    document.documentElement.lang = this.language();
    document.title = `${this.t('brand')} | ${this.t('portal')}`;
    const token = sessionStorage.getItem('fc-token');
    const savedUser = sessionStorage.getItem('fc-user');
    if (token && savedUser) {
      try {
        const profile = JSON.parse(savedUser) as UserProfile;
        this.user.set(profile);
        this.loadEmailStatus();
        this.loadInvoices();
        this.loadNotifications();
        if (profile.role === 'admin') { this.loadClients(); this.loadAgents(); this.loadChecks(); this.loadEmailTemplates(); this.loadEmailLog(); }
        if (profile.role === 'admin' && this.reconciliationView()) this.loadReconciliation();
        if (profile.role === 'admin') this.resumeInvoiceSyncJob();
      } catch { this.clearSession(); }
    }
  }

  ngOnDestroy() {
    this.destroyDashboardChart();
  }

  ngAfterViewInit() {
    requestAnimationFrame(() => this.updateDashboardChart());
  }

  ngAfterViewChecked() {
    // El canvas aparece/desaparece con el @if del Dashboard, por eso no basta
    // con inicializarlo únicamente durante el primer ciclo de la vista.
    const nextCanvas = this.dashboardChartCanvasRef?.nativeElement
      || document.querySelector<HTMLCanvasElement>('#dashboard-chart-canvas')
      || undefined;
    if (nextCanvas === this.dashboardCanvasElement) return;
    this.dashboardCanvasElement = nextCanvas;
    if (!nextCanvas) {
      this.destroyDashboardChart();
      return;
    }
    requestAnimationFrame(() => this.updateDashboardChart());
  }

  setLanguage(language: Language) {
    this.language.set(language);
    localStorage.setItem('fc-language', language);
    document.documentElement.lang = language;
    document.title = `${this.t('brand')} | ${this.t('portal')}`;
  }

  openReconciliation() {
    this.accountView.set(false);
    this.preferencesView.set(false);
    this.taskCenterTab.set(this.user()?.role === 'admin' ? 'reconciliation' : 'modified_sos');
    this.reconciliationView.set(true);
    this.reconciliationSection.set('invoices');
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'reconciliation');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
    if (this.user()?.role === 'admin') this.loadReconciliation();
  }

  openCreditReconciliation() {
    this.reconciliationSection.set('credits');
    this.loadCreditReconciliation();
  }

  openInvoiceReconciliation() {
    this.reconciliationSection.set('invoices');
    if (this.user()?.role === 'admin') this.loadReconciliation();
  }

  async loadCreditReconciliation() {
    this.creditReconciliationLoading.set(true);
    try {
      let page = 1; let result: CreditReconciliationResponse | null = null; const rows: CreditReconciliationRow[] = [];
      do {
        result = await firstValueFrom(this.http.get<CreditReconciliationResponse>(`/api/reconciliation/credits?page=${page}&pageSize=100`, this.authOptions()));
        rows.push(...(result.rows || []));
        if (!result.pagination || rows.length >= result.pagination.total || !result.rows.length) break;
        page += 1;
      } while (page < 1000);
      if (result) { this.creditReconciliationRows.set(rows); this.creditReconciliationTotals.set(result.totals); this.creditReconciliationSource.set(result.source); }
    } catch (error) { this.notify(this.errorMessage(error)); }
    finally { this.creditReconciliationLoading.set(false); }
  }

  uploadCreditReconciliationExcel(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.creditReconciliationLoading.set(true);
    const formData = new FormData();
    formData.append('excel', file);
    this.http.post<{ message: string }>('/api/reconciliation/credits/upload', formData, this.authOptions()).subscribe({
      next: response => {
        this.notify(response.message);
        (event.target as HTMLInputElement).value = '';
        this.loadCreditReconciliation();
      },
      error: error => {
        this.creditReconciliationLoading.set(false);
        (event.target as HTMLInputElement).value = '';
        this.notify(this.errorMessage(error));
      }
    });
  }

  creditReconciliationValidationLabel(row: CreditReconciliationRow) {
    const labels = this.language() === 'es'
      ? { valid: 'Correcto', 'amount-different': 'Monto diferente', missing: 'Faltante', duplicate: 'Duplicado' }
      : { valid: 'Matched', 'amount-different': 'Amount different', missing: 'Missing', duplicate: 'Duplicate' };
    return labels[row.validation];
  }

  toggleCreditCustomerFilter(event: MouseEvent) {
    event.stopPropagation();
    this.creditReportCustomerFilterOpen.update(open => !open);
  }

  cycleReconciliationResultSort() {
    const current = this.reconciliationSort();
    this.reconciliationSort.set(current === 'date' ? 'missing' : current === 'missing' ? 'found' : 'date');
  }

  showDashboard() {
    this.reconciliationView.set(false);
    this.accountView.set(false);
    this.preferencesView.set(false);
    this.activeTab.set('dashboard');
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  showInvoices() {
    this.reconciliationView.set(false);
    this.accountView.set(false);
    this.preferencesView.set(false);
        this.activeTab.set('invoices');
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  showClients() {
    this.reconciliationView.set(false);
    this.accountView.set(false);
    this.preferencesView.set(false);
    this.activeTab.set('clients');
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  t(key: keyof typeof LOGIN_COPY['en']) { return LOGIN_COPY[this.language()][key]; }

  formatCustomerDisplay(value: string) {
    const source = String(value || '');
    if (this.customerAliasKey(source) === 'we-got-flowers') return 'We Got Flowers';
    return source.toLocaleLowerCase().replace(/(^|[\s/-])([a-záéíóúñ])/g, (_, separator, letter) => `${separator}${letter.toLocaleUpperCase()}`);
  }

  statusLabel(invoice: Invoice) {
    if (this.invoiceBalance(invoice) <= 0) return this.t('paid');
    const today = new Date().toISOString().slice(0, 10);
    const dueDate = String(invoice.due || '').slice(0, 10);
    if (dueDate && dueDate < today) return this.t('overdue');
    if (invoice.status === 'Pendiente') {
      return this.hasReceiving(invoice) ? this.t('received') : this.t('pending');
    }
    return this.t('overdue');
  }
  invoiceVisibleToUser(invoice: Invoice, current: { role: Role; email?: string; clientKey?: string; assignedClients?: string[] } | null) {
    if (!current) return false;
    const assignedClients = current.assignedClients || [];
    const invoiceKey = this.customerAliasKey(invoice.clientKey || invoice.client);
    if (assignedClients.length > 0) {
      const assignedKeys = assignedClients.map(value => this.customerAliasKey(value));
      return assignedKeys.includes(invoiceKey);
    }
    if (current.role === 'admin') return true;
    return (!!current.clientKey && invoiceKey === this.customerAliasKey(current.clientKey)) || invoice.email?.toLowerCase() === current.email?.toLowerCase();
  }

  canViewPortalModule(permission: PortalPermission) {
    const current = this.user();
    if (!current) return false;
    if (!current.permissions?.length) {
      return current.role === 'admin' || ['dashboard', 'invoices', 'credits', 'accountStatement', 'preferences'].includes(permission);
    }
    return current.permissions.includes(permission);
  }

  toggleClientModulePermission(permission: PortalPermission) {
    const permissions = this.clientForm.permissions;
    this.clientForm.permissions = permissions.includes(permission)
      ? permissions.filter(item => item !== permission)
      : [...permissions, permission];
  }

  clientPermissionSummary(client: ClientUser) {
    if (!client.permissions?.length) return client.role === 'admin' ? (this.language() === 'es' ? 'Todas' : 'All') : '5';
    return String(client.permissions.length);
  }

  normalizeClientName(value: string) {
    return String(value || '').trim().toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  login() {
    if (this.loading() || !this.loginUser.trim()) return;
    if (this.loginStep() === 'password' && !this.loginPassword.trim()) {
      this.loginError.set(this.language() === 'es' ? 'La contraseña es obligatoria.' : 'Password is required.');
      return;
    }
    this.loading.set(true);
    this.loginError.set('');
    this.http.post<AuthResponse | { requiresPassword: true }>('/api/auth/login', {
      username: this.loginUser.trim(), password: this.loginStep() === 'password' ? this.loginPassword : undefined
    }).subscribe({
      next: response => {
        if ('requiresPassword' in response) {
          this.loading.set(false);
          this.loginStep.set('password');
          return;
        }
        sessionStorage.setItem('fc-token', response.token);
        sessionStorage.setItem('fc-user', JSON.stringify(response.user));
        this.loadInvoices(() => {
          this.user.set(response.user);
          this.loadEmailStatus();
          this.loadNotifications();
          if (response.user.role === 'admin') { this.loadClients(); this.loadAgents(); this.loadChecks(); this.loadEmailTemplates(); this.loadEmailLog(); }
        });
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
    this.notifications.set([]);
    this.notificationOpen.set(false);
    this.activeTab.set('dashboard');
  }

  openCustomerSupport() {
    this.menuOpen.set(false);
    this.supportTicketNumber.set('');
    this.supportConversationTicket.set(null);
    this.supportForm = { category: this.language() === 'es' ? 'Factura o saldo' : 'Invoice or balance', subject: '', message: '' };
    this.supportOpen.set(true);
  }

  openMyAccount() {
    this.menuOpen.set(false);
    this.accountView.set(true);
    this.preferencesView.set(false);
    this.reconciliationView.set(false);
    this.accountTab.set('personal');
    this.accountMessage.set('');
    this.accountError.set('');
    this.loadAccount();
  }

  openPreferences() {
    this.menuOpen.set(false);
    this.accountView.set(false);
    this.preferencesView.set(true);
    this.reconciliationView.set(false);
  }

  accountDisplayName() {
    const formName = [this.accountForm.firstName, this.accountForm.lastName].filter(Boolean).join(' ').trim();
    return formName || this.user()?.name || '';
  }

  accountRoleLabel() {
    return this.user()?.role === 'admin' ? this.t('admin') : this.t('client');
  }

  private loadAccount() {
    this.accountLoading.set(true);
    this.http.get<UserProfile>('/api/account', this.authOptions()).subscribe({
      next: profile => {
        const nameParts = profile.name.trim().split(/\s+/);
        this.accountForm = {
          firstName: profile.firstName?.trim() || nameParts.shift() || '',
          lastName: profile.lastName?.trim() || nameParts.join(' '),
          phone: profile.phone || '',
          email: profile.email || ''
        };
        this.user.set(profile);
        sessionStorage.setItem('fc-user', JSON.stringify(profile));
        this.accountLoading.set(false);
      },
      error: error => {
        this.accountLoading.set(false);
        this.accountError.set(this.errorMessage(error) || this.t('accountLoadError'));
      }
    });
  }

  saveAccountProfile() {
    const firstName = this.accountForm.firstName.trim();
    const email = this.accountForm.email.trim();
    if (!firstName || !email) {
      this.accountError.set(this.t('requiredFields'));
      this.accountMessage.set('');
      return;
    }
    this.accountSaving.set(true);
    this.accountError.set('');
    this.accountMessage.set('');
    this.http.patch<AuthResponse & { message: string }>('/api/account/profile', {
      firstName,
      lastName: this.accountForm.lastName.trim(),
      phone: this.accountForm.phone.trim(),
      email
    }, this.authOptions()).subscribe({
      next: response => {
        this.user.set(response.user);
        sessionStorage.setItem('fc-user', JSON.stringify(response.user));
        sessionStorage.setItem('fc-token', response.token);
        this.accountForm = {
          ...this.accountForm,
          firstName: response.user.firstName || firstName,
          lastName: response.user.lastName || this.accountForm.lastName.trim(),
          email: response.user.email || email
        };
        this.accountSaving.set(false);
        this.accountMessage.set(response.message || this.t('accountSaved'));
      },
      error: error => {
        this.accountSaving.set(false);
        this.accountError.set(this.errorMessage(error));
      }
    });
  }

  changeAccountPassword() {
    const { currentPassword, newPassword, confirmPassword } = this.passwordForm;
    if (!currentPassword || !newPassword || !confirmPassword) {
      this.accountError.set(this.t('requiredFields'));
      this.accountMessage.set('');
      return;
    }
    if (newPassword !== confirmPassword) {
      this.accountError.set(this.t('passwordMismatch'));
      this.accountMessage.set('');
      return;
    }
    this.passwordSaving.set(true);
    this.accountError.set('');
    this.accountMessage.set('');
    this.http.patch<{ message: string }>('/api/account/password', {
      currentPassword,
      newPassword,
      confirmPassword
    }, this.authOptions()).subscribe({
      next: response => {
        this.passwordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };
        this.passwordSaving.set(false);
        this.accountMessage.set(response.message || this.t('passwordChanged'));
      },
      error: error => {
        this.passwordSaving.set(false);
        this.accountError.set(this.errorMessage(error));
      }
    });
  }

  loadNotifications() {
    if (!this.user()) return;
    this.http.get<PortalNotification[]>('/api/notifications', this.authOptions()).subscribe({
      next: notifications => this.notifications.set(notifications),
      error: error => this.notify(this.errorMessage(error))
    });
  }

  openNotification(notification: PortalNotification) {
    this.notificationOpen.set(false);
    this.supportNotificationLoading.set(true);
    this.supportOpen.set(true);
    if (!notification.read) {
      this.http.patch(`/api/notifications/${notification.id}/read`, {}, this.authOptions()).subscribe({
        next: () => this.notifications.update(items => items.map(item => item.id === notification.id ? { ...item, read: true } : item)),
        error: error => this.notify(this.errorMessage(error))
      });
    }
    this.http.get<SupportTicket[]>('/api/support/tickets/mine', this.authOptions()).subscribe({
      next: tickets => {
        const ticket = tickets.find(item => item.id === notification.ticketId);
        if (!ticket) {
          this.supportNotificationLoading.set(false);
          return this.notify(this.language() === 'es' ? 'No se encontró la solicitud.' : 'The request was not found.');
        }
        this.supportConversationTicket.set(ticket);
        this.supportNotificationLoading.set(false);
      },
      error: error => {
        this.supportNotificationLoading.set(false);
        if (this.user()) this.notify(this.errorMessage(error));
      }
    });
  }

  deleteNotification(event: Event, notification: PortalNotification) {
    event.stopPropagation();
    this.notifications.update(items => items.filter(item => item.id !== notification.id));
    this.http.delete(`/api/notifications/${notification.id}`, this.authOptions()).subscribe({
      next: () => undefined,
      error: error => {
        this.notifications.update(items => items.some(item => item.id === notification.id) ? items : [notification, ...items]);
        if (this.user()) this.notify(this.errorMessage(error));
      }
    });
  }

  sendSupportReply(ticket: SupportTicket) {
    const message = this.supportReplyText().trim();
    if (!message) return;
    this.supportReplySending.set(true);
    this.http.post<{ message: string; ticket: SupportTicket }>(`/api/support/tickets/${ticket.id}/replies`, { message }, this.authOptions()).subscribe({
      next: response => {
        if (!this.user()) return;
        this.supportReplySending.set(false);
        this.supportTickets.update(tickets => tickets.map(item => item.id === response.ticket.id ? response.ticket : item));
        this.selectedSupportTicket.set(response.ticket);
        this.supportReplyText.set('');
        this.notify(this.language() === 'es' ? 'Respuesta enviada al cliente.' : 'Reply sent to customer.');
      },
      error: error => {
        this.supportReplySending.set(false);
        if (this.user()) this.notify(this.errorMessage(error));
      }
    });
  }

  loadSupportTickets() {
    if (this.user()?.role !== 'admin') return;
    this.supportTicketsLoading.set(true);
    this.http.get<SupportTicket[]>('/api/support/tickets', this.authOptions()).subscribe({
      next: tickets => {
        this.supportTickets.set(tickets);
        this.supportTicketsLoading.set(false);
      },
      error: error => {
        this.supportTicketsLoading.set(false);
        if (this.user()) this.notify(this.errorMessage(error));
      }
    });
  }

  openSupportInbox() {
    this.taskCenterTab.set('support');
    this.reconciliationView.set(true);
    this.selectedSupportTicket.set(null);
    this.loadSupportTickets();
  }

  updateSupportTicketStatus(ticket: SupportTicket, status: SupportTicketStatus) {
    this.http.patch<{ message: string; ticket: SupportTicket }>(`/api/support/tickets/${ticket.id}`, { status }, this.authOptions()).subscribe({
      next: response => {
        if (!this.user()) return;
        this.supportTickets.update(tickets => tickets.map(item => item.id === response.ticket.id ? response.ticket : item));
        this.selectedSupportTicket.set(response.ticket);
        this.notify(this.language() === 'es' ? 'Estado del ticket actualizado.' : 'Ticket status updated.');
      },
      error: error => { if (this.user()) this.notify(this.errorMessage(error)); }
    });
  }

  deleteSupportTicket(event: Event, ticket: SupportTicket) {
    event.stopPropagation();
    const confirmed = window.confirm(this.language() === 'es'
      ? `¿Eliminar el ticket ${ticket.number}? Esta acción también eliminará sus notificaciones.`
      : `Delete ticket ${ticket.number}? This will also remove its notifications.`);
    if (!confirmed) return;
    this.http.delete(`/api/support/tickets/${ticket.id}`, this.authOptions()).subscribe({
      next: () => {
        this.supportTickets.update(tickets => tickets.filter(item => item.id !== ticket.id));
        if (this.selectedSupportTicket()?.id === ticket.id) this.selectedSupportTicket.set(null);
      },
      error: error => { if (this.user()) this.notify(this.errorMessage(error)); }
    });
  }

  supportTicketStatusLabel(status: SupportTicketStatus) {
    const labels: Record<SupportTicketStatus, string> = this.language() === 'es'
      ? { open: 'Abierto', in_progress: 'En progreso', resolved: 'Resuelto' }
      : { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
    return labels[status];
  }

  closeCustomerSupport() {
    if (!this.supportSending() && !this.supportReplySending()) {
      this.supportOpen.set(false);
      this.supportConversationTicket.set(null);
      this.supportNotificationLoading.set(false);
    }
  }

  submitSupport() {
    const subject = this.supportForm.subject.trim();
    const message = this.supportForm.message.trim();
    if (!subject || !message) {
      this.notify(this.language() === 'es' ? 'Completa el asunto y la descripción.' : 'Complete the subject and description.');
      return;
    }
    this.supportSending.set(true);
    this.http.post<{ message: string; ticket: { number: string } }>('/api/support/tickets', {
      category: this.supportForm.category,
      subject,
      message
    }, this.authOptions()).subscribe({
      next: response => {
        this.supportSending.set(false);
        this.supportTicketNumber.set(response.ticket.number);
        this.supportForm = { ...this.supportForm, subject: '', message: '' };
      },
      error: error => {
        this.supportSending.set(false);
        if (this.user()) this.notify(this.errorMessage(error));
      }
    });
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
    if (invoice.readOnly) return;
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
    if (invoice.readOnly) return;
    this.editingInvoice.set(invoice);
    this.editInvoiceForm = {
      folio: invoice.folio,
      poNumber: invoice.poNumber || '',
      guideNumber: invoice.guideNumber || '',
      client: invoice.client,
      email: invoice.email,
      concept: invoice.concept,
      issued: invoice.issued,
      due: invoice.due,
      amount: invoice.amount,
      balance: this.invoiceBalance(invoice),
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

  private async openWalmexDocument(url: string, title: string) {
    const popup = window.open('about:blank', '_blank');
    try {
      const token = sessionStorage.getItem('fc-token') || '';
      const response = await fetch(`/api/walmex/document?url=${encodeURIComponent(url)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        popup?.close();
        this.notify(response.status === 401 ? (this.language() === 'es' ? 'La sesión expiró. Ingresa nuevamente.' : 'Your session expired. Please sign in again.') : (this.language() === 'es' ? 'No fue posible abrir el documento.' : 'The document could not be opened.'));
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      if (popup) popup.location.href = objectUrl;
      else window.open(objectUrl, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      popup?.close();
      this.notify(this.language() === 'es' ? `No fue posible abrir ${title || 'el documento'}.` : `Unable to open ${title || 'the document'}.`);
    }
  }

  openPdf(type: 'invoice' | 'receiving', invoice: Invoice) {
    if (invoice.walmexSource) {
      const url = type === 'invoice' ? invoice.invoiceSharePointUrl : invoice.receivingSharePointUrl;
      if (url) void this.openWalmexDocument(url, type === 'invoice' ? 'la factura' : 'el recibimiento');
      else this.notify(this.language() === 'es' ? 'Este archivo todavía no está disponible.' : 'This file is not available yet.');
      return;
    }
    const url = type === 'invoice' ? invoice.invoiceSharePointUrl : invoice.receivingSharePointUrl;
    if ((!url && !invoice.id) || invoice.reconciliationStatus === 'missing') {
      this.notify(this.language() === 'es' ? 'Este archivo todavía no está disponible.' : 'This file is not available yet.');
      return;
    }
    const token = sessionStorage.getItem('fc-token');
    const endpoint = `/api/invoices/${invoice.id}/${type === 'invoice' ? 'pdf' : 'receiving-pdf'}?token=${encodeURIComponent(token || '')}`;
    const title = type === 'invoice'
      ? (this.language() === 'es' ? 'Factura' : 'Invoice')
      : (this.language() === 'es' ? 'Recibimiento' : 'Receiving');
    const fileName = type === 'invoice'
      ? (invoice.invoiceFileName || `Invoice-${invoice.folio}.pdf`)
      : (invoice.receivingFileName || `Receiving-${invoice.folio}.pdf`);
    this.showPdfViewer(endpoint, `${title} ${invoice.folio}`, invoice.client, fileName);
  }

  openInvoicePrintDocuments(invoice: Invoice) {
    if (invoice.walmexSource) {
      for (const url of [invoice.invoiceSharePointUrl, invoice.receivingSharePointUrl].filter(Boolean)) void this.openWalmexDocument(url, 'el documento');
      return;
    }
    if (!invoice.id || invoice.reconciliationStatus === 'missing') {
      this.notify(this.language() === 'es' ? 'Los archivos todavía no están disponibles.' : 'The files are not available yet.');
      return;
    }
    const token = sessionStorage.getItem('fc-token');
    this.showPdfViewer(
      `/api/invoices/${invoice.id}/print-pdf?token=${encodeURIComponent(token || '')}`,
      `${this.language() === 'es' ? 'Factura + recibimiento' : 'Invoice + receiving'} ${invoice.folio}`,
      invoice.client,
      `Invoice-${invoice.folio}-Print.pdf`
    );
  }

  // --- Enviar factura + recibimiento por correo ---

  private readonly emailDefaultTemplateKey = '__default__';



  /** Registro de envios: se escribe desde siempre, ahora tambien se lee. */
  emailLogEntries = signal<{ invoiceId: number; creditNumber?: string; statementKey?: string; sentAt: string; to: string[]; includedReceiving: boolean }[]>([]);

  loadEmailLog() {
    this.http.get<{ entries: { invoiceId: number; creditNumber?: string; statementKey?: string; sentAt: string; to: string[]; includedReceiving: boolean }[] }>('/api/email-log', this.authOptions()).subscribe({
      next: response => this.emailLogEntries.set(response.entries || []),
      error: () => { /* sin registro la tabla se ve como siempre */ }
    });
  }

  /** Ultimo envio de cada factura, con cuantas veces se mando. */
  private invoiceSendMap = computed(() => {
    const map = new Map<string, { sentAt: string; to: string[]; includedReceiving: boolean; count: number }>();
    for (const entry of this.emailLogEntries()) {
      if (!entry?.invoiceId) continue;
      if (entry.creditNumber) continue; // los envios de devolucion no marcan la factura
      const key = String(entry.invoiceId);
      const previous = map.get(key);
      const count = (previous?.count || 0) + 1;
      // se conserva el mas reciente, sin importar el orden en que lleguen
      if (previous && String(previous.sentAt) >= String(entry.sentAt)) {
        map.set(key, { ...previous, count });
      } else {
        map.set(key, { sentAt: entry.sentAt, to: entry.to || [], includedReceiving: entry.includedReceiving, count });
      }
    }
    return map;
  });

  /** Devoluciones ya enviadas: invoiceId + creditNumber. */
  private creditSendSet = computed(() => {
    const set = new Set<string>();
    for (const entry of this.emailLogEntries()) {
      if (entry?.invoiceId && entry.creditNumber) set.add(String(entry.invoiceId) + '|' + entry.creditNumber);
    }
    return set;
  });

  creditWasSent(invoice: Invoice, credit: CreditRecord): boolean {
    return this.creditSendSet().has(String(invoice.id) + '|' + String(credit.creditNumber || ''));
  }

  invoiceWasSent(invoice: Invoice): boolean {
    return this.invoiceSendMap().has(String(invoice.id));
  }

  invoiceSentTooltip(invoice: Invoice): string {
    const info = this.invoiceSendMap().get(String(invoice.id));
    if (!info) return '';
    const spanish = this.language() === 'es';
    const when = new Date(info.sentAt);
    const stamp = this.formatDate(info.sentAt.slice(0, 10)) + ' '
      + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
    const lines = [(spanish ? 'Enviado ' : 'Sent ') + stamp];
    if (info.to.length) {
      const rest = info.to.length - 1;
      lines.push((spanish ? 'Para: ' : 'To: ') + info.to[0]
        + (rest > 0 ? (spanish ? ` y ${rest} más` : ` and ${rest} more`) : ''));
    }
    const extras: string[] = [];
    if (info.includedReceiving) extras.push(spanish ? 'Con recibimiento' : 'With receiving');
    if (info.count > 1) extras.push(info.count + (spanish ? ' envíos' : ' sends'));
    if (extras.length) lines.push(extras.join(' · '));
    return lines.join(String.fromCharCode(10));
  }

  loadEmailTemplates() {
    this.http.get<{ templates: EmailTemplate[] }>('/api/email-templates', this.authOptions()).subscribe({
      next: response => {
        this.emailTemplates.set(response.templates || []);
      },
      error: () => { /* La plantilla se puede escribir a mano si no cargó. */ }
    });
  }

  loadEmailStatus() {
    this.http.get<{ mailReady: boolean; mailFrom: string; mailFromCentro: string }>('/api/email-status', this.authOptions()).subscribe({
      next: response => {
        this.emailReady.set(response.mailReady !== false);
        this.emailFrom.set(response.mailFrom || '');
      },
      error: () => { /* No afecta la autorización ni el flujo de envío. */ }
    });
  }

  /**
   * El catalogo de plantillas viaja sin logotipo porque pesa mucho, asi que
   * el envio masivo lo pide aparte. Se recuerda por llave: en una tanda son
   * dos o tres plantillas, no una por cliente.
   */
  private templateLogoCache = new Map<string, string>();

  private async templateLogo(templateKey: string): Promise<string> {
    if (!templateKey) return '';
    const cached = this.templateLogoCache.get(templateKey);
    if (cached !== undefined) return cached;
    try {
      const response = await firstValueFrom(this.http.get<{ template: EmailTemplate }>(
        `/api/email-templates/${encodeURIComponent(templateKey)}`, this.authOptions()));
      const logo = response?.template?.logo || '';
      this.templateLogoCache.set(templateKey, logo);
      return logo;
    } catch {
      // sin logotipo el correo sale igual, solo sin la firma de imagen
      return '';
    }
  }

  /**
   * Logotipo del correo de devolucion. La plantilla de devoluciones puede no
   * tener uno guardado, asi que cae al de la empresa antes de quedarse sin
   * firma. Solo escribe si el cuadro sigue abierto en la misma factura.
   */
  private async loadCreditEmailLogo(creditKey: string, companyKey: string, invoiceId: string | number) {
    const logo = (await this.templateLogo(creditKey)) || (await this.templateLogo(companyKey));
    if (!logo) return;
    if (String(this.emailInvoice()?.id || '') !== String(invoiceId || '')) return;
    this.emailLogo.set(logo);
  }

  private loadEmailTemplateLogo(templateKey: string | undefined, context: 'invoice' | 'statement', invoiceId?: string | number) {
    if (!templateKey) return;
    this.http.get<{ template: EmailTemplate }>(`/api/email-templates/${encodeURIComponent(templateKey)}`, this.authOptions()).subscribe({
      next: response => {
        const logo = response.template?.logo || '';
        if (context === 'invoice') {
          if (String(this.emailInvoice()?.id || '') !== String(invoiceId || '')) return;
          this.emailLogo.set(logo);
        } else if (this.stmtEmailOpen()) {
          this.stmtEmailLogo.set(logo);
        }
      },
      error: () => { /* El correo sigue funcionando sin logotipo. */ }
    });
  }

  private invoiceClientKey(invoice: Invoice) {
    return invoice.clientKey || invoice.client.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  emailPlaceholderValues(invoice: Invoice): Record<string, string> {
    return {
      factura: invoice.folio || '',
      cliente: invoice.client || '',
      po: invoice.poNumber || '',
      guia: invoice.guideNumber || '',
      monto: this.formatMoney(Number(invoice.amount || 0)),
      saldo: this.formatMoney(this.invoiceBalance(invoice)),
      emision: invoice.issued || '',
      vencimiento: invoice.due || ''
    };
  }

  applyEmailPlaceholders(text: string, invoice: Invoice) {
    const values = this.emailPlaceholderValues(invoice);
    return String(text || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key) => {
      const normalized = String(key).toLowerCase();
      return Object.prototype.hasOwnProperty.call(values, normalized) ? values[normalized] : match;
    });
  }

  // ── Envio masivo de facturas ──
  bulkOpen = signal(false);
  bulkFrom = signal('');
  bulkTo = signal('');
  bulkOnlyUnsent = signal(true);
  bulkUnselected = signal<string[]>([]);
  bulkSending = signal(false);
  bulkDone = signal(0);
  bulkResults = signal<Record<string, 'ok' | 'error'>>({});
  bulkError = signal('');

  /** Destinatarios guardados de cada cliente, por su llave de agrupacion. */
  private bulkRecipients = computed(() => {
    const map: Record<string, string> = {};
    for (const invoice of this.invoices()) {
      const aliasKey = this.customerAliasKey(invoice.client);
      if (map[aliasKey] !== undefined) continue;
      map[aliasKey] = this.user()?.role === 'admin' ? this.invoiceEmailContext(invoice).to : (this.user()?.email || '');
    }
    return map;
  });

  bulkRows = computed<BulkSendRow[]>(() => {
    const current = this.user();
    const candidates: BulkSendInvoice[] = [];
    for (const invoice of this.invoices()) {
      if (invoice.readOnly || !invoice.id) continue;
      if (!this.invoiceVisibleToUser(invoice, current)) continue;
      candidates.push({
        id: String(invoice.id),
        folio: invoice.folio || '',
        client: this.customerDisplayName(invoice.client),
        aliasKey: this.customerAliasKey(invoice.client),
        issued: invoice.issued || '',
        hasReceiving: this.hasReceiving(invoice),
        alreadySent: this.invoiceWasSent(invoice),
      });
    }
    return buildBulkSendRows(candidates, {
      from: this.bulkFrom(),
      to: this.bulkTo(),
      onlyUnsent: this.bulkOnlyUnsent(),
      recipients: this.bulkRecipients(),
    });
  });

  /** Renglones que no se pueden enviar, para que se vea a quien falta correo. */
  bulkBlockedRows = computed(() => this.bulkRows().filter(row => !row.selectable));
  bulkReadyRows = computed(() => this.bulkRows().filter(row => row.selectable));

  private bulkSelectedIds = computed(() => {
    const out = new Set<string>();
    const unselected = new Set(this.bulkUnselected());
    for (const row of this.bulkReadyRows()) {
      for (const invoice of row.invoices) {
        const id = String(invoice.id);
        if (!unselected.has(id)) out.add(id);
      }
    }
    return out;
  });

  bulkSummary = computed(() => bulkSendSummary(this.bulkRows(), this.bulkSelectedIds()));

  isBulkInvoiceSelected(id: string | number): boolean {
    return !this.bulkUnselected().includes(String(id));
  }

  isBulkRowSelected(row: BulkSendRow): boolean {
    return row.selectable && row.invoices.some(invoice => this.isBulkInvoiceSelected(invoice.id));
  }

  toggleBulkInvoice(id: string | number) {
    const unselected = this.bulkUnselected();
    const key = String(id);
    this.bulkUnselected.set(unselected.includes(key) ? unselected.filter(item => item !== key) : [...unselected, key]);
  }

  toggleBulkRow(row: BulkSendRow) {
    if (!row.selectable) return;
    const ids = row.invoices.map(invoice => String(invoice.id));
    const unselected = this.bulkUnselected();
    this.bulkUnselected.set(this.isBulkRowSelected(row)
      ? [...unselected, ...ids.filter(id => !unselected.includes(id))]
      : unselected.filter(id => !ids.includes(id)));
  }

  openBulkSend() {
    const today = App.todayIso();
    this.bulkFrom.set(this.bulkFrom() || today);
    this.bulkTo.set(this.bulkTo() || today);
    this.bulkUnselected.set([]);
    this.bulkResults.set({});
    this.bulkDone.set(0);
    this.bulkError.set('');
    this.bulkOpen.set(true);
  }

  closeBulkSend() {
    if (this.bulkSending()) return;
    this.bulkOpen.set(false);
  }

  bulkResultOf(id: string | number): 'ok' | 'error' | null {
    return this.bulkResults()[String(id)] || null;
  }

  /**
   * Manda una por una, por la misma ruta que el cuadro manual. La pausa
   * entre correos evita que Graph corte por ráfaga, y saveTemplate va en
   * falso para que una tanda no reescriba la plantilla de la empresa.
   */
  async sendBulkInvoices() {
    if (this.bulkSending()) return;
    const selected = this.bulkSelectedIds();
    const pending: Invoice[] = [];
    for (const invoice of this.invoices()) {
      if (invoice.id && selected.has(String(invoice.id))) pending.push(invoice);
    }
    if (!pending.length) return;

    this.bulkSending.set(true);
    this.bulkDone.set(0);
    this.bulkResults.set({});
    this.bulkError.set('');

    for (const invoice of pending) {
      const context = this.invoiceEmailContext(invoice);
      try {
        await firstValueFrom(this.http.post(`/api/invoices/${invoice.id}/send-email`, {
          to: context.to,
          cc: context.cc,
          subject: context.subject,
          bodyHtml: context.bodyHtml,
          // el catalogo viene sin logotipo, hay que pedirlo aparte
          logo: context.logo || await this.templateLogo(context.logoKey),
          saveTemplate: false,
          clientKey: context.clientKey,
          companyKey: context.companyKey,
        }, this.authOptions()));
        this.bulkResults.set({ ...this.bulkResults(), [String(invoice.id)]: 'ok' });
      } catch (error) {
        this.bulkResults.set({ ...this.bulkResults(), [String(invoice.id)]: 'error' });
        this.bulkError.set(this.errorMessage(error));
      }
      this.bulkDone.set(this.bulkDone() + 1);
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    this.bulkSending.set(false);
    if (this.user()?.role === 'admin') this.loadEmailLog();
    const ok = Object.values(this.bulkResults()).filter(value => value === 'ok').length;
    const failed = Object.values(this.bulkResults()).filter(value => value === 'error').length;
    this.notify(this.language() === 'es'
      ? `${ok} correo(s) enviado(s)${failed ? `, ${failed} con error` : ''}.`
      : `${ok} email(s) sent${failed ? `, ${failed} failed` : ''}.`);
  }

  // ===== Envio masivo de estados de cuenta =====
  // A diferencia del de facturas, aqui la unidad es el cliente: sale un correo
  // por cliente con su estado completo adjunto, y solo lo ve un administrador.

  stmtBulkOpen = signal(false);
  stmtBulkUnselected = signal<string[]>([]);
  stmtBulkSending = signal(false);
  stmtBulkDone = signal(0);
  stmtBulkCurrent = signal('');
  stmtBulkResults = signal<Record<string, 'ok' | 'error'>>({});
  stmtBulkError = signal('');

  /** Ultimo estado de cuenta enviado a cada cliente, por su llave de grupo. */
  private statementSendMap = computed(() => {
    const map: Record<string, string> = {};
    for (const entry of this.emailLogEntries()) {
      const key = String(entry?.statementKey || '');
      if (!key) continue;
      // se conserva el mas reciente, sin importar el orden en que lleguen
      if (String(entry.sentAt) > (map[key] || '')) map[key] = String(entry.sentAt);
    }
    return map;
  });

  stmtBulkRows = computed<BulkStatementRow[]>(() => {
    const recipients: Record<string, string> = {};
    const groups: BulkStatementGroup[] = [];
    // el universo es lo que ya esta en pantalla, con los filtros puestos
    for (const group of this.accountStatementGroups()) {
      const context = this.statementEmailContext(group);
      recipients[context.aliasKey] = context.to;
      groups.push({
        aliasKey: context.aliasKey,
        name: group.customerName,
        invoices: group.rows.length,
        balance: group.totals.balance,
        issuer: context.issuer,
      });
    }
    return buildBulkStatementRows(groups, { recipients, lastSent: this.statementSendMap() });
  });

  /** Renglones que no se pueden enviar, para que se vea a quien falta correo. */
  stmtBulkBlockedRows = computed(() => this.stmtBulkRows().filter(row => !row.selectable));
  stmtBulkReadyRows = computed(() => this.stmtBulkRows().filter(row => row.selectable));

  stmtBulkSummary = computed(() => bulkStatementSummary(this.stmtBulkRows(), new Set(this.stmtBulkUnselected())));

  isStmtBulkSelected(aliasKey: string): boolean {
    return !this.stmtBulkUnselected().includes(aliasKey);
  }

  toggleStmtBulk(aliasKey: string) {
    const unselected = this.stmtBulkUnselected();
    this.stmtBulkUnselected.set(unselected.includes(aliasKey)
      ? unselected.filter(item => item !== aliasKey)
      : [...unselected, aliasKey]);
  }

  openStmtBulk() {
    this.stmtBulkUnselected.set([]);
    this.stmtBulkResults.set({});
    this.stmtBulkDone.set(0);
    this.stmtBulkCurrent.set('');
    this.stmtBulkError.set('');
    this.stmtBulkOpen.set(true);
  }

  closeStmtBulk() {
    if (this.stmtBulkSending()) return;
    this.stmtBulkOpen.set(false);
  }

  stmtBulkResultOf(aliasKey: string): 'ok' | 'error' | null {
    return this.stmtBulkResults()[aliasKey] || null;
  }

  /** "12 sep" del ultimo envio, o vacio si nunca se le ha mandado. */
  stmtBulkLastSentLabel(row: BulkStatementRow): string {
    if (!row.lastSentAt) return '';
    const date = new Date(row.lastSentAt);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(this.language() === 'es' ? 'es-MX' : 'en-US',
      { day: '2-digit', month: 'short' });
  }

  /**
   * Manda uno por uno, por la misma ruta que el cuadro manual, para que el
   * remitente por empresa y el mensaje guardado se comporten igual. La pausa
   * entre correos evita que Graph corte por ráfaga, y saveTemplate va en falso
   * para que una tanda no reescriba la plantilla de la empresa.
   */
  async sendBulkStatements() {
    if (this.stmtBulkSending()) return;
    const queue = bulkStatementQueue(this.stmtBulkRows(), new Set(this.stmtBulkUnselected()));
    if (!queue.length) return;

    const groups = new Map<string, any>();
    for (const group of this.accountStatementGroups()) {
      groups.set(this.customerAliasKey(group.customerName), group);
    }

    this.stmtBulkSending.set(true);
    this.stmtBulkDone.set(0);
    this.stmtBulkResults.set({});
    this.stmtBulkError.set('');

    for (const row of queue) {
      this.stmtBulkCurrent.set(row.name);
      try {
        const group = groups.get(row.aliasKey);
        if (!group) throw new Error(this.language() === 'es'
          ? 'El cliente ya no está en pantalla.' : 'The customer is no longer on screen.');
        const context = this.statementEmailContext(group);
        // el masivo manda Excel: la imagen se dibuja desde el cuadro abierto
        const attachmentBase64 = await this.buildStatementExcelBase64(group);
        const slug = String(group.customerName || 'cliente').toLowerCase().replace(/[^a-z0-9]+/gi, '-');
        // el agente va en copia igual que en el envio manual, sin repetirse
        const cc = [...new Set([...String(context.cc).split(/[;,]/), context.agent?.email || '']
          .map(item => item.trim()).filter(Boolean))].join(', ');
        // el renglon se armo con lo guardado, el envio tiene que usar lo mismo
        if (!context.to.trim()) throw new Error(this.language() === 'es'
          ? 'El cliente no tiene destinatario guardado.' : 'The customer has no saved recipient.');
        await firstValueFrom(this.http.post('/api/account-statement/send-email', {
          to: context.to,
          cc,
          subject: context.subject,
          bodyHtml: context.bodyHtml,
          // el catalogo viene sin logotipo, hay que pedirlo aparte
          logo: context.logo || await this.templateLogo(context.logoKey),
          attachmentBase64,
          attachmentName: 'estado-de-cuenta-' + slug + '.xlsx',
          placeholders: this.statementPlaceholderValues(group),
          issuer: context.issuer,
          saveTemplate: false,
          clientKey: context.clientKey,
          companyKey: context.companyKey,
          client: group.customerName,
        }, this.authOptions()));
        this.stmtBulkResults.set({ ...this.stmtBulkResults(), [row.aliasKey]: 'ok' });
      } catch (error) {
        this.stmtBulkResults.set({ ...this.stmtBulkResults(), [row.aliasKey]: 'error' });
        this.stmtBulkError.set(this.errorMessage(error));
      }
      this.stmtBulkDone.set(this.stmtBulkDone() + 1);
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    this.stmtBulkSending.set(false);
    this.stmtBulkCurrent.set('');
    if (this.user()?.role === 'admin') this.loadEmailLog();
    const ok = Object.values(this.stmtBulkResults()).filter(value => value === 'ok').length;
    const failed = Object.values(this.stmtBulkResults()).filter(value => value === 'error').length;
    this.notify(this.language() === 'es'
      ? `${ok} estado(s) de cuenta enviado(s)${failed ? `, ${failed} con error` : ''}.`
      : `${ok} statement(s) sent${failed ? `, ${failed} failed` : ''}.`);
  }

  /**
   * Con que se manda el correo de una factura: destinatarios del cliente y
   * mensaje de la empresa. Lo usan el cuadro manual y el envio masivo, para
   * que uno no se comporte distinto del otro.
   */
  private invoiceEmailContext(invoice: Invoice) {
    const aliasKey = this.customerAliasKey(invoice.client);
    const templates = this.emailTemplates();
    const issuer = this.invoiceIssuerKey(invoice);
    const companyTemplate = templates.find(item => item.clientKey === companyTemplateKey('invoice', issuer)) || null;
    const clientTemplate = findClientTemplate(templates, 'invoice', aliasKey, this.customerLegacyKeys(aliasKey));
    const generalTemplate = templates.find(item => item.clientKey === this.emailDefaultTemplateKey) || null;
    // el mensaje es de la empresa; el registro del cliente solo aporta
    // destinatarios (y el texto viejo, hasta que la empresa tenga el suyo)
    const message = companyTemplate || clientTemplate || generalTemplate;
    const template = clientTemplate || generalTemplate;
    const logoTemplate = companyTemplate || template;
    const spanish = this.language() === 'es';
    return {
      aliasKey,
      to: template?.to || invoice.email || '',
      cc: template?.cc || '',
      subject: message?.subject || (spanish ? 'Factura {{factura}} — {{cliente}}' : 'Invoice {{factura}} — {{cliente}}'),
      bodyHtml: message?.bodyHtml || (spanish
        ? '<p>Estimado cliente,</p><p>Adjuntamos la factura <strong>{{factura}}</strong> por {{monto}}, con vencimiento el {{vencimiento}}, junto con su recibimiento.</p><p>Quedamos atentos a cualquier consulta.</p><p>Saludos cordiales,<br>Pacifica Farms</p>'
        : '<p>Dear customer,</p><p>Please find attached invoice <strong>{{factura}}</strong> for {{monto}}, due on {{vencimiento}}, along with its receiving document.</p><p>We remain at your service.</p><p>Best regards,<br>Pacifica Farms</p>'),
      logo: logoTemplate?.logo || '',
      logoKey: logoTemplate?.clientKey,
      companyName: this.issuerName(issuer),
      companyKey: companyTemplateKey('invoice', issuer),
      clientKey: clientTemplateKey('invoice', aliasKey),
      origin: (companyTemplate ? 'company' : clientTemplate ? 'client' : generalTemplate ? 'general' : 'none') as 'company' | 'client' | 'general' | 'none',
    };
  }

  openEmailDialog(invoice: Invoice) {
    if (invoice.readOnly) return;
    if (!invoice.id || invoice.reconciliationStatus === 'missing') {
      this.notify(this.language() === 'es' ? 'Los archivos todavía no están disponibles.' : 'The files are not available yet.');
      return;
    }
    const context = this.invoiceEmailContext(invoice);
    this.emailTemplateCompany.set(context.companyName);
    this.emailTemplateOrigin.set(context.origin);

    this.emailInvoice.set(invoice);
    this.emailTo.set(this.user()?.role === 'admin' ? context.to : (this.user()?.email || ''));
    this.emailCc.set(this.user()?.role === 'admin' ? context.cc : '');
    this.emailSubject.set(context.subject);
    const body = context.bodyHtml;
    this.emailBody.set(body);
    this.emailBodyInitial.set(body);
    this.emailLogo.set(context.logo);
    const agent = this.agentForCustomerName(this.customerDisplayName(invoice.client));
    this.emailAgent.set(agent);
    this.emailIncludeAgent.set(!!agent?.email);
    this.emailFieldContext.set('invoice');
    this.emailCreditContext.set(null);
    this.emailSaveTemplate.set(this.user()?.role === 'admin');
    this.emailDialogOpen.set(true);
    this.loadEmailTemplateLogo(context.logoKey, 'invoice', invoice.id);
    this.tinymceError.set(false);
    // TinyMCE puede conservar la instancia entre aperturas; asegúrate de que
    // reciba el mensaje actual aunque el editor ya estuviera inicializado.
    const syncEmailEditor = (attempt = 0) => {
      if (this.tinymceEditor?.setContent) {
        this.tinymceEditor.setContent(body);
        return;
      }
      if (attempt < 20) window.setTimeout(() => syncEmailEditor(attempt + 1), 50);
    };
    syncEmailEditor();
    this.loadTinymceScript().catch(() => {
      this.notify(this.language() === 'es' ? 'No se pudo cargar el editor de mensajes.' : 'The message editor could not be loaded.');
    });
  }

  closeEmailDialog() {
    if (this.emailSending()) return;
    this.emailDialogOpen.set(false);
    this.emailInvoice.set(null);
    this.emailCreditContext.set(null);
  }

  // Editor TinyMCE autohospedado: los archivos se sirven desde /tinymce. Se
  // carga al abrir el diálogo para no pesar en el arranque del portal.
  private tinymceEditor: any = null;
  private tinymceLoading: Promise<void> | null = null;
  tinymceReady = signal(false);
  tinymceError = signal(false);

  private loadTinymceScript() {
    if ((window as any).tinymce) { this.tinymceReady.set(true); return Promise.resolve(); }
    if (this.tinymceLoading) return this.tinymceLoading;
    this.tinymceLoading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'tinymce/tinymce.min.js';
      script.referrerPolicy = 'origin';
      script.onload = () => { this.tinymceReady.set(true); resolve(); };
      script.onerror = () => {
        this.tinymceLoading = null;
        this.tinymceError.set(true);
        reject(new Error('No se pudo cargar el editor.'));
      };
      document.head.appendChild(script);
    });
    return this.tinymceLoading;
  }

  readonly emailEditorInit = {
    base_url: '/tinymce',
    suffix: '.min',
    license_key: 'gpl',
    height: 330,
    menubar: 'edit insert format table',
    plugins: 'lists link image table code preview autolink charmap emoticons searchreplace visualblocks wordcount',
    toolbar: 'undo redo | blocks fontsize | bold italic underline forecolor backcolor | alignleft aligncenter alignright alignjustify | bullist numlist outdent indent | link image table | camposfactura | removeformat preview code',
    branding: false,
    promotion: false,
    statusbar: true,
    content_style: 'body{font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2933;line-height:1.55;margin:12px}',
    setup: (editor: any) => {
      this.tinymceEditor = editor;
      // Menú propio para insertar los campos que se rellenan al enviar.
      editor.ui.registry.addMenuButton('camposfactura', {
        text: this.language() === 'es' ? 'Campos' : 'Fields',
        fetch: (callback: (items: any[]) => void) => {
          const items = this.activePlaceholderKeys().map(key => ({
            type: 'menuitem',
            text: this.emailPlaceholderLabel(key),
            onAction: () => editor.insertContent(`{{${key}}}`)
          }));
          callback(items);
        }
      });
    },
    toolbar_mode: 'wrap'
  };

  readonly emailPlaceholderKeys = ['factura', 'cliente', 'po', 'guia', 'monto', 'saldo', 'emision', 'vencimiento'];
  readonly statementPlaceholderKeys = ['cliente', 'saldo', 'facturas', 'fecha', 'empresa', 'agente'];

  /** Que cuadro de correo esta abierto, para ofrecer sus campos. */
  emailFieldContext = signal<'invoice' | 'statement' | 'credit'>('invoice');
  /** Nota de devolución en curso; cuando existe, el cuadro va en modo credit. */
  emailCreditContext = signal<CreditRecord | null>(null);
  readonly creditPlaceholderKeys = ['cliente', 'credito', 'monto', 'factura', 'fecha'];

  activePlaceholderKeys(): string[] {
    if (this.emailFieldContext() === 'statement') return this.statementPlaceholderKeys;
    if (this.emailFieldContext() === 'credit') return this.creditPlaceholderKeys;
    return this.emailPlaceholderKeys;
  }

  /** Valores con los que el servidor rellena {{campo}} en el estado de cuenta. */
  statementPlaceholderValues(group: any): Record<string, string> {
    const agent = this.stmtEmailAgent();
    return {
      cliente: group.customerName || '',
      saldo: this.formatMoney(group.totals.balance),
      facturas: String(group.rows.length),
      fecha: this.formatDate(new Date().toISOString().slice(0, 10)),
      empresa: this.groupIssuerName(group),
      agente: agent?.name || ''
    };
  }

  emailPlaceholderLabel(key: string) {
    const labels: Record<string, { es: string; en: string }> = {
      factura: { es: 'Número de factura', en: 'Invoice number' },
      cliente: { es: 'Nombre del cliente', en: 'Customer name' },
      credito: { es: 'Número de devolución', en: 'Return number' },
      facturas: { es: 'Facturas abiertas', en: 'Open invoices' },
      fecha: { es: 'Fecha de hoy', en: 'Today' },
      empresa: { es: 'Empresa emisora', en: 'Issuing company' },
      agente: { es: 'Agente asignado', en: 'Assigned agent' },
      po: { es: 'Número de PO', en: 'PO number' },
      guia: { es: 'Número de guía', en: 'Guide number' },
      monto: { es: 'Monto de la factura', en: 'Invoice amount' },
      saldo: { es: 'Saldo pendiente', en: 'Outstanding balance' },
      emision: { es: 'Fecha de emisión', en: 'Issue date' },
      vencimiento: { es: 'Fecha de vencimiento', en: 'Due date' }
    };
    return this.language() === 'es' ? labels[key]?.es || key : labels[key]?.en || key;
  }

  insertEmailPlaceholder(key: string) {
    this.tinymceEditor?.insertContent(`{{${key}}}`);
  }

  // El logo se reescala antes de guardarlo para que la plantilla no crezca de más.
  onEmailLogoSelected(event: Event, target: 'invoice' | 'statement' = 'invoice') {
    const logoSignal = target === 'statement' ? this.stmtEmailLogo : this.emailLogo;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      this.notify(this.language() === 'es' ? 'Selecciona una imagen para el logo.' : 'Select an image for the logo.');
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxWidth = 480;
        const scale = Math.min(1, maxWidth / image.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
        logoSignal.set(canvas.toDataURL('image/png'));
        input.value = '';
      };
      image.onerror = () => {
        this.notify(this.language() === 'es' ? 'No se pudo leer la imagen.' : 'The image could not be read.');
        input.value = '';
      };
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  }

  clearEmailLogo(target: 'invoice' | 'statement' = 'invoice') {
    (target === 'statement' ? this.stmtEmailLogo : this.emailLogo).set('');
  }

  /** Llave del mensaje de devolución, compartido por empresa. */
  private creditCompanyKey(issuer: 'pacifica' | 'centro'): string {
    return 'cr:co:' + issuer;
  }

  /** Valores para {{campo}} del correo de devolución. */
  private creditPlaceholderValues(invoice: Invoice, credit: CreditRecord): Record<string, string> {
    return {
      cliente: this.customerDisplayName(invoice.client),
      credito: String(credit.creditNumber || ''),
      monto: this.formatMoney(Number(credit.amount || 0)),
      factura: invoice.folio || '',
      fecha: this.formatDate(new Date().toISOString().slice(0, 10)),
    };
  }

  /** Abre el cuadro para enviar la nota de devolución por correo. */
  openCreditEmailDialog(invoice: Invoice, credit: CreditRecord, event: Event) {
    event.stopPropagation();
    if (!invoice.id) return;
    // destinatarios y logo salen de lo ya configurado en facturas
    const context = this.invoiceEmailContext(invoice);
    const issuer = this.invoiceIssuerKey(invoice);
    const creditTemplate = this.emailTemplates().find(item => item.clientKey === this.creditCompanyKey(issuer)) || null;
    const spanish = this.language() === 'es';

    this.emailInvoice.set(invoice);
    this.emailCreditContext.set(credit);
    this.emailTemplateCompany.set(context.companyName);
    this.emailTemplateOrigin.set(creditTemplate ? 'company' : 'none');
    this.emailTo.set(this.user()?.role === 'admin' ? context.to : (this.user()?.email || ''));
    this.emailCc.set(this.user()?.role === 'admin' ? context.cc : '');
    this.emailSubject.set(creditTemplate?.subject || (spanish
      ? 'Nota de devolución {{credito}} — {{cliente}}'
      : 'Return note {{credito}} — {{cliente}}'));
    const body = creditTemplate?.bodyHtml || (spanish
      ? '<p>Estimado cliente,</p><p>Adjuntamos la nota de devolución <strong>{{credito}}</strong> por {{monto}}, correspondiente a la factura {{factura}}.</p><p>Quedamos atentos a cualquier consulta.</p><p>Saludos cordiales,<br>{{cliente}}</p>'
      : '<p>Dear customer,</p><p>Please find attached return note <strong>{{credito}}</strong> for {{monto}}, related to invoice {{factura}}.</p><p>We remain at your service.</p><p>Best regards</p>');
    this.emailBody.set(body);
    this.emailBodyInitial.set(body);
    // el logo que ya está configurado para la empresa
    this.emailLogo.set(creditTemplate?.logo || context.logo);
    const agent = this.agentForCustomerName(this.customerDisplayName(invoice.client));
    this.emailAgent.set(agent);
    this.emailIncludeAgent.set(!!agent?.email);
    this.emailFieldContext.set('credit');
    this.emailSaveTemplate.set(this.user()?.role === 'admin');
    this.emailDialogOpen.set(true);
    this.tinymceError.set(false);
    // la plantilla de devoluciones puede no traer logotipo; entonces se usa el
    // de la empresa, que es el que el cliente ya reconoce
    this.loadCreditEmailLogo(creditTemplate?.clientKey || '', context.logoKey, invoice.id);
    const sync = (attempt = 0) => {
      if (this.tinymceEditor?.setContent) { this.tinymceEditor.setContent(body); return; }
      if (attempt < 40) setTimeout(() => sync(attempt + 1), 50);
    };
    this.loadTinymceScript().then(() => sync()).catch(() => this.tinymceError.set(true));
  }

  sendInvoiceEmail() {
    const credit = this.emailCreditContext();
    if (credit) { this.sendCreditEmail(this.emailInvoice(), credit); return; }

    const invoice = this.emailInvoice();
    if (!invoice || this.emailSending()) return;
    if (!this.emailTo().trim()) {
      this.notify(this.language() === 'es' ? 'Captura al menos un destinatario.' : 'Enter at least one recipient.');
      return;
    }
    const agent = this.emailAgent();
    const ccParts = [this.emailCc().trim()];
    if (this.emailIncludeAgent() && agent?.email) ccParts.push(agent.email);
    this.emailSending.set(true);
    this.http.post<{ message: string }>(`/api/invoices/${invoice.id}/send-email`, {
      to: this.emailTo(),
      cc: ccParts.filter(Boolean).join(', '),
      subject: this.emailSubject(),
      bodyHtml: this.emailBody(),
      logo: this.emailLogo(),
      saveTemplate: this.emailSaveTemplate(),
      clientKey: clientTemplateKey('invoice', this.customerAliasKey(invoice.client)),
      companyKey: companyTemplateKey('invoice', this.invoiceIssuerKey(invoice))
    }, this.authOptions()).subscribe({
      next: response => {
        this.notify(response.message);
        this.emailSending.set(false);
        this.emailDialogOpen.set(false);
        this.emailInvoice.set(null);
        if (this.user()?.role === 'admin' && this.emailSaveTemplate()) this.loadEmailTemplates();
        if (this.user()?.role === 'admin') this.loadEmailLog();
      },
      error: error => { this.notify(this.errorMessage(error)); this.emailSending.set(false); }
    });
  }

  /** Envía la nota de devolución: mismo remitente por empresa, mensaje propio. */
  private sendCreditEmail(invoice: Invoice | null, credit: CreditRecord) {
    if (!invoice || !invoice.id || this.emailSending()) return;
    if (!this.emailTo().trim()) {
      this.notify(this.language() === 'es' ? 'Captura al menos un destinatario.' : 'Enter at least one recipient.');
      return;
    }
    const agent = this.emailAgent();
    const ccParts = [this.emailCc().trim()];
    if (this.emailIncludeAgent() && agent?.email) ccParts.push(agent.email);
    this.emailSending.set(true);
    this.http.post<{ message: string }>(`/api/invoices/${invoice.id}/send-credit-email`, {
      to: this.emailTo(),
      cc: ccParts.filter(Boolean).join(', '),
      subject: this.emailSubject(),
      bodyHtml: this.emailBody(),
      logo: this.emailLogo(),
      placeholders: this.creditPlaceholderValues(invoice, credit),
      saveTemplate: this.emailSaveTemplate(),
      companyKey: this.creditCompanyKey(this.invoiceIssuerKey(invoice)),
      creditNumber: credit.creditNumber || '',
      creditPath: credit.creditPdfPath || ''
    }, this.authOptions()).subscribe({
      next: response => {
        this.notify(response.message);
        this.emailSending.set(false);
        this.emailDialogOpen.set(false);
        this.emailInvoice.set(null);
        this.emailCreditContext.set(null);
        if (this.user()?.role === 'admin' && this.emailSaveTemplate()) this.loadEmailTemplates();
        if (this.user()?.role === 'admin') this.loadEmailLog();
      },
      error: error => { this.notify(this.errorMessage(error)); this.emailSending.set(false); }
    });
  }

  private showPdfViewer(url: string, title: string, subtitle: string, fileName: string) {
    this.pdfViewerRawUrl.set(url);
    this.pdfViewerUrl.set(null);
    this.pdfViewerTitle.set(title);
    this.pdfViewerSubtitle.set(subtitle);
    this.pdfViewerFileName.set(fileName.replace(/[\\/:*?"<>|]+/g, '-'));
    this.pdfViewerError.set('');
    this.pdfViewerLoading.set(true);
    this.pdfViewerOpen.set(true);
    this.loadPdfBlob(url).then(objectUrl => {
      if (!this.pdfViewerOpen() || this.pdfViewerRawUrl() !== url) return;
      this.pdfViewerUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(objectUrl));
      this.pdfViewerLoading.set(false);
    }).catch(() => {
      if (!this.pdfViewerOpen() || this.pdfViewerRawUrl() !== url) return;
      this.pdfViewerError.set(this.language() === 'es'
        ? 'No fue posible abrir este PDF.'
        : 'This PDF could not be opened.');
      this.pdfViewerLoading.set(false);
    });
  }
  hasReceiving(invoice: Invoice) {
    return Boolean(invoice.receivingPdfPath || invoice.receivingSharePointUrl);
  }

  private loadPdfBlob(url: string): Promise<string> {
    const cachedUrl = this.pdfBlobCache.get(url);
    if (cachedUrl) return Promise.resolve(cachedUrl);
    const loading = this.pdfBlobLoading.get(url);
    if (loading) return loading;
    const request = new Promise<string>((resolve, reject) => {
      this.http.get(url, { responseType: 'blob' }).subscribe({
        next: blob => {
          if (blob.type && blob.type !== 'application/pdf') {
            this.pdfBlobLoading.delete(url);
            reject(new Error(`Unexpected PDF response type: ${blob.type}`));
            return;
          }
          if (this.pdfBlobCache.size >= 32) {
            const oldestKey = this.pdfBlobCache.keys().next().value as string | undefined;
            if (oldestKey) {
              URL.revokeObjectURL(this.pdfBlobCache.get(oldestKey)!);
              this.pdfBlobCache.delete(oldestKey);
            }
          }
          const objectUrl = URL.createObjectURL(blob);
          this.pdfBlobCache.set(url, objectUrl);
          this.pdfBlobLoading.delete(url);
          resolve(objectUrl);
        },
        error: error => {
          this.pdfBlobLoading.delete(url);
          reject(error);
        }
      });
    });
    this.pdfBlobLoading.set(url, request);
    return request;
  }

  pdfViewerLoaded() {
    if (this.pdfViewerOpen()) this.pdfViewerLoading.set(false);
  }

  closePdfViewer() {
    this.pdfViewerOpen.set(false);
    this.pdfViewerLoading.set(false);
    this.pdfViewerUrl.set(null);
    this.pdfViewerError.set('');
    this.pdfViewerRawUrl.set('');
  }

  downloadPdfViewer() {
    const url = this.pdfViewerRawUrl();
    if (!url) return;
    const cachedUrl = this.pdfBlobCache.get(url);
    if (cachedUrl) {
      const anchor = document.createElement('a');
      anchor.href = cachedUrl;
      anchor.download = this.pdfViewerFileName();
      anchor.click();
      return;
    }
    this.http.get(url, { responseType: 'blob' }).subscribe({
      next: blob => {
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = this.pdfViewerFileName();
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      },
      error: () => this.notify(this.language() === 'es' ? 'No fue posible descargar el PDF.' : 'The PDF could not be downloaded.')
    });
  }

  async printPdfViewer() {
    const sourceUrl = this.pdfViewerRawUrl();
    if (!sourceUrl) return;
    try {
      const objectUrl = this.pdfBlobCache.get(sourceUrl) || await this.loadPdfBlob(sourceUrl);
      const frame = window.document.createElement('iframe');
      frame.style.position = 'fixed';
      frame.style.width = '1px';
      frame.style.height = '1px';
      frame.style.opacity = '0';
      frame.style.pointerEvents = 'none';
      frame.src = objectUrl;
      frame.onload = () => setTimeout(() => { frame.contentWindow?.focus(); frame.contentWindow?.print(); }, 250);
      window.document.body.appendChild(frame);
      setTimeout(() => frame.remove(), 60000);
    } catch {
      this.notify(this.language() === 'es' ? 'No fue posible abrir la impresión.' : 'Printing could not be opened.');
    }
  }

  @HostListener('document:keydown.escape')
  closePdfViewerWithEscape() {
    if (this.pdfViewerOpen()) this.closePdfViewer();
  }

  creditFlagsForInvoice(invoice: Invoice): CreditRecord[] {
    const ownCredits = (invoice.credits || []).filter(credit => {
      if (credit.creditFlagHidden) return false;
      if (credit.creditFlagTargetInvoiceId === undefined || credit.creditFlagTargetInvoiceId === null) return true;
      return Number(credit.creditFlagTargetInvoiceId) === invoice.id;
    });
    const redirectedCredits = this.invoices()
      .filter(sourceInvoice => sourceInvoice.id !== invoice.id)
      .flatMap(sourceInvoice => (sourceInvoice.credits || []).filter(credit => !credit.creditFlagHidden && Number(credit.creditFlagTargetInvoiceId) === invoice.id));
    const seen = new Set<string>();
    return [...ownCredits, ...redirectedCredits].filter(credit => {
      if (!credit.creditPdfPath && !credit.creditSharePointUrl) return false;
      const key = `${credit.creditNumber || ''}|${credit.creditPdfPath || credit.creditSharePointUrl}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Notas de devolucion de la factura que tienen PDF para abrir. */
  invoiceReturns(invoice: Invoice): CreditRecord[] {
    return this.creditFlagsForInvoice(invoice).filter(credit => credit.creditSharePointUrl || credit.creditPdfPath);
  }

  /** Total devuelto de la factura, para la columna Devolucion. */
  invoiceReturnTotal(invoice: Invoice): number {
    return this.invoiceReturns(invoice).reduce((sum, credit) => sum + Number(credit.amount || 0), 0);
  }

  /** Abre las notas de devolucion unidas en un solo PDF. */
  openCreditsPdf(invoice: Invoice, event: Event) {
    event.stopPropagation();
    if (!invoice.id) return;
    const returns = this.invoiceReturns(invoice);
    // una sola nota en SharePoint no pasa por el union: se abre directo
    if (returns.length === 1 && returns[0].creditSharePointUrl && !returns[0].creditPdfPath) {
      window.open(returns[0].creditSharePointUrl, '_blank', 'noopener');
      return;
    }
    const token = sessionStorage.getItem('fc-token');
    this.showPdfViewer(
      `/api/invoices/${invoice.id}/credits-pdf?token=${encodeURIComponent(token || '')}`,
      `${this.language() === 'es' ? 'Devolución' : 'Return'} · ${invoice.folio || ''}`.trim(),
      invoice.client,
      `Return-${invoice.folio || invoice.id}.pdf`
    );
  }

  openCreditPdf(invoice: Invoice, credit: CreditRecord, event: Event) {
    event.stopPropagation();
    if (credit.creditSharePointUrl) {
      window.open(credit.creditSharePointUrl, '_blank', 'noopener');
      return;
    }
    if (credit.creditPdfPath && invoice.id) {
      const token = sessionStorage.getItem('fc-token');
      // Los créditos que solo viven en Oracle no tienen enlace de SharePoint.
      // Ábrelos en el visor del portal para conservar la sesión actual y
      // evitar que una pestaña nueva los redirija al login.
      this.showPdfViewer(
        `/api/invoices/${invoice.id}/credit-pdf?creditNumber=${encodeURIComponent(credit.creditNumber || '')}&creditPath=${encodeURIComponent(credit.creditPdfPath)}&token=${encodeURIComponent(token || '')}`,
        `${this.language() === 'es' ? 'Crédito' : 'Credit'} ${credit.creditNumber || ''}`.trim(),
        invoice.client,
        `Credit-${credit.creditNumber || invoice.folio}.pdf`
      );
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
    if (invoice.readOnly) return;
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
    if (invoice.readOnly) return;
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
    this.clientPermissionSearch.set('');
    this.clientForm = client
      ? { name: client.name, username: client.username, email: client.email, password: '', role: client.role, permissions: [...(client.permissions || [])], assignedClients: (client.assignedClients || []).map(value => this.customerDisplayName(value)) }
      : { name: '', username: '', email: '', password: '', role: 'client', permissions: ['dashboard', 'invoices', 'credits', 'accountStatement', 'preferences'], assignedClients: [] };
    this.showClientForm.set(true);
  }

  toggleClientPermission(clientName: string) {
    const list = this.clientForm.assignedClients;
    if (list.some(value => this.customerMatches(value, clientName))) {
      this.clientForm.assignedClients = list.filter(value => !this.customerMatches(value, clientName));
    } else {
      this.clientForm.assignedClients = [...list, this.customerDisplayName(clientName)];
    }
  }

  selectAllClientPermissions() {
    this.clientForm.assignedClients = [...this.customerOptions()];
  }

  clearClientPermissions() {
    this.clientForm.assignedClients = [];
  }

  saveClient() {
    const editing = this.editingClient();
    if (!this.clientForm.name || !this.clientForm.username || !this.clientForm.email || (!editing && !this.clientForm.password)) {
      this.notify(this.language() === 'es' ? 'Completa los campos obligatorios antes de guardar.' : 'Complete the required fields before saving.');
      return;
    }
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
        if (this.editingClient()?.id === client.id) {
          this.editingClient.set(null);
          this.showClientForm.set(false);
        }
        this.notify(this.t('clientDeleted'));
      },
      error: error => this.notify(this.errorMessage(error))
    });
  }

  invoiceBalance(invoice: Invoice) {
    return invoice.status === 'Pagada'
      ? 0
      : Math.max(0, Number(invoice.balance ?? invoice.amount - (invoice.creditAmount || 0)));
  }

  private accountStatementBalance(invoice: Invoice) {
    return accountStatementInvoiceBalance(invoice, this.statementDateTo());
  }

  /** Razones sociales con las que este cliente pudo guardarse antes. */
  private customerLegacyKeys(aliasKey: string): string[] {
    const keys = new Set<string>();
    for (const invoice of this.invoices()) {
      if (this.customerAliasKey(invoice.client) !== aliasKey) continue;
      const key = this.invoiceClientKey(invoice);
      if (key) keys.add(key);
    }
    return [...keys];
  }

  private customerAliasKey(value: string): string {
    const normalized = this.normalizeClientName(value);
    // Gringo South y Dos Gringos son el mismo cliente con dos razones sociales
    if (this.isDosGringosCustomer(value)) return 'gringo-south';
    if (normalized === 'we-got-flower' || normalized === 'we-got-flowers') return 'we-got-flowers';
    if (normalized === 'trader-joe-s' || normalized === 'trader-joes') return 'trader-joes';
    if (normalized === 'washington-floral-service-inc-spokane' || normalized === 'wfs-spokane') return 'washington-floral-service-inc-spokane';
    if (normalized === 'stemaline-wholesale' || normalized === 'stemline-wholesale') return 'stemline-wholesale';
    if (normalized === 'galleria-farms' || normalized === 'galleria-farms-flores') return 'galleria-farms';
    if (normalized === 'billdoran-co-portland' || normalized === 'bill-doran-co-portland' || normalized === 'bill-doran-portland') return 'bill-doran-portland';
    if (normalized === 'bill-doran-springfield' || normalized === 'billdoran-springfield') return 'bill-doran-springfield';
    if (normalized === 'a-perris-farms' || normalized === 'on-time-fresh-express-a-perris-farms') return 'a-perris-farms';
    if (normalized === 'oberer-s-flowers-inc' || normalized === 'oberers-flowers-deruette') return 'oberer-s-flowers-inc';
    if (normalized === 'dutches-bouquets' || normalized === 'dutchess-bouquets' || normalized === 'dutchess-buquets') return 'dutchess-bouquets';
    if (normalized === 'dr-delphinium') return 'dr-delphinium';
    if (normalized === 'arizona-floral-exchage' || normalized === 'arizona-floral-exchange') return 'arizona-floral-exchange';
    return normalized;
  }

  private customerDisplayName(value: string): string {
    const source = String(value || '');
    const aliasKey = this.customerAliasKey(source);
    if (aliasKey === 'gringo-south') return 'GRINGO SOUTH SA DE CV';
    if (aliasKey === 'we-got-flowers') return 'We Got Flowers';
    if (aliasKey === 'trader-joes') return "Trader Joe's";
    if (aliasKey === 'washington-floral-service-inc-spokane') return 'Washington Floral Service, Inc.-Spokane';
    if (aliasKey === 'stemline-wholesale') return 'Stemline Wholesale';
    if (aliasKey === 'galleria-farms') return 'Galleria Farms';
    if (aliasKey === 'bill-doran-portland') return 'Bill Doran Portland';
    if (aliasKey === 'bill-doran-springfield') return 'Bill Doran - Springfield';
    if (aliasKey === 'a-perris-farms') return 'A PERRIS FARMS';
    if (aliasKey === 'oberer-s-flowers-inc') return 'Oberer´s Flowers Inc';
    if (aliasKey === 'dutchess-bouquets') return 'Dutchess Bouquets';
    if (aliasKey === 'dr-delphinium') return 'Dr. Delphinium';
    if (aliasKey === 'arizona-floral-exchange') return 'Arizona Floral Exchange';
    return source;
  }

  private customerMatches(value: string, selectedCustomer: string): boolean {
    if (selectedCustomer !== 'all' && this.isDosGringosCustomer(value) && this.isDosGringosCustomer(selectedCustomer)) return true;
    return selectedCustomer === 'all' || this.customerAliasKey(value) === this.customerAliasKey(selectedCustomer);
  }

  private isDosGringosCustomer(value: string): boolean {
    const normalized = this.normalizeClientName(value);
    return normalized.includes('gringo-south') || normalized.includes('gringo-ventures-dba-dos-gringos');
  }

  private invoiceFilterCustomerName(value: string): string {
    return this.isDosGringosCustomer(value) ? 'Gringo South' : this.customerDisplayName(value);
  }

  private checkCustomerMatches(value: string, selectedCustomer: string): boolean {
    return selectedCustomer === 'all' || this.checkCustomerAliasKey(value) === this.checkCustomerAliasKey(selectedCustomer);
  }

  private checkCustomerAliasKey(value: string): string {
    const normalized = this.normalizeClientName(value);
    if (normalized.startsWith('bill-doran-') || normalized.startsWith('billdoran-')) return 'bill-doran';
    return this.customerAliasKey(value);
  }

  private customerQueryMatches(value: string, query: string): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return true;
    const rawValue = String(value || '').toLowerCase();
    const displayValue = this.customerDisplayName(value).toLowerCase();
    return rawValue.includes(normalizedQuery) || displayValue.includes(normalizedQuery);
  }

  private accountStatementCustomerGroupKey(invoice: Invoice): string {
    const source = invoice.client || invoice.clientKey || String(invoice.id);
    return this.customerAliasKey(source) || String(invoice.id);
  }

  private accountStatementCustomerDisplayName(invoice: Invoice): string {
    return this.customerDisplayName(invoice.client || invoice.clientKey || '');
  }

  private accountStatementCustomerMatches(invoice: Invoice, selectedCustomers: string[]): boolean {
    if (!selectedCustomers.length) return true;

    // The API can return a technical clientKey that is different from the
    // human-readable client name.  Match both values so the statement uses
    // the same customer grouping as the invoices table (including the two
    // Gringo South/Dos Gringos document formats).
    return selectedCustomers.some(selectedCustomer => this.customerMatches(invoice.client || '', selectedCustomer)
      || this.customerMatches(invoice.clientKey || '', selectedCustomer));
  }

  private accountStatementAgingRow(invoice: Invoice): AccountStatementAgingRow {
    const balance = this.accountStatementBalance(invoice);
    const daysExpiration = this.accountStatementDaysExpiration(invoice.due || invoice.issued);
    const agingBucket: AccountStatementAgingBucket = daysExpiration <= 0 ? '0' : daysExpiration <= 30 ? '1-30' : daysExpiration <= 60 ? '31-60' : daysExpiration <= 90 ? '61-90' : '90+';
    return {
      invoice,
      customerCode: invoice.clientKey || invoice.client || '',
      customerName: invoice.client || '',
      daysExpiration,
      agingBucket,
      bucketAmounts: { '0': agingBucket === '0' ? balance : 0, '1-30': agingBucket === '1-30' ? balance : 0, '31-60': agingBucket === '31-60' ? balance : 0, '61-90': agingBucket === '61-90' ? balance : 0, '90+': agingBucket === '90+' ? balance : 0 },
      balance
    };
  }

  sortAccountStatement(key: AccountStatementSortKey) {
    if (this.accountStatementSortKey() === key) {
      this.accountStatementSortDirection.set(this.accountStatementSortDirection() === 'asc' ? 'desc' : 'asc');
      return;
    }
    this.accountStatementSortKey.set(key);
    this.accountStatementSortDirection.set(key === 'date' || key === 'expiration' ? 'desc' : 'asc');
  }

  accountStatementSortIndicator(key: AccountStatementSortKey): string {
    if (this.accountStatementSortKey() !== key) return '↕';
    return this.accountStatementSortDirection() === 'asc' ? '↑' : '↓';
  }

  private compareAccountStatementRows(a: AccountStatementAgingRow, b: AccountStatementAgingRow): number {
    const key = this.accountStatementSortKey();
    const direction = this.accountStatementSortDirection() === 'asc' ? 1 : -1;
    let result = 0;
    if (key === 'daysExpiration') {
      result = a.daysExpiration - b.daysExpiration;
    } else if (key === '0' || key === '1-30' || key === '31-60' || key === '61-90' || key === '90+') {
      result = a.bucketAmounts[key] - b.bucketAmounts[key];
    } else {
      const values: Record<'expiration' | 'date' | 'poNumber' | 'invoice', string> = {
        expiration: a.invoice.due || '',
        date: a.invoice.issued || '',
        poNumber: a.invoice.poNumber || '',
        invoice: a.invoice.folio || ''
      };
      const otherValues: Record<'expiration' | 'date' | 'poNumber' | 'invoice', string> = {
        expiration: b.invoice.due || '',
        date: b.invoice.issued || '',
        poNumber: b.invoice.poNumber || '',
        invoice: b.invoice.folio || ''
      };
      result = values[key].localeCompare(otherValues[key], undefined, { numeric: true, sensitivity: 'base' });
    }
    return result * direction || Number(a.invoice.id) - Number(b.invoice.id);
  }

  private accountStatementDaysExpiration(dateValue: string): number {
    if (!dateValue) return 0;
    const dueTime = Date.parse(`${String(dateValue).slice(0, 10)}T00:00:00Z`);
    // Al simular un corte, la antigüedad debe calcularse contra esa fecha,
    // no contra hoy. Así cambian también las columnas de aging y el Excel.
    const reportDate = this.statementDateTo() || new Date().toISOString().slice(0, 10);
    const reportTime = Date.parse(`${reportDate}T00:00:00Z`);
    if (Number.isNaN(dueTime) || Number.isNaN(reportTime)) return 0;
    return Math.round((reportTime - dueTime) / 86400000);
  }

  private accountStatementBucketLabel(bucket: AccountStatementAgingBucket): string {
    const labels: Record<Language, Record<AccountStatementAgingBucket, string>> = {
      en: { '0': '0 Days', '1-30': '1-30 Days', '31-60': '31-60 Days', '61-90': '61-90 Days', '90+': '90 more days' },
      es: { '0': '0 días', '1-30': '1-30 días', '31-60': '31-60 días', '61-90': '61-90 días', '90+': 'Más de 90 días' }
    };
    return labels[this.language()][bucket];
  }

  formatMoney(value: number) {
    return new Intl.NumberFormat(this.language() === 'en' ? 'en-US' : 'es-MX', { style: 'currency', currency: 'USD' }).format(value);
  }

  formatCompactMoney(value: number) {
    const currency = this.language() === 'en' ? 'en-US' : 'es-MX';
    if (Math.abs(value) >= 1_000_000) return new Intl.NumberFormat(currency, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(value);
    if (Math.abs(value) >= 1_000) return new Intl.NumberFormat(currency, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 0 }).format(value);
    return this.formatMoney(value);
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
  isSyncingInvoices = signal(false);
  isSyncingStatement = signal(false);
  syncResult = signal<SyncResult | null>(null);
  invoiceSyncProgress = signal<InvoiceSyncJob | null>(null);
  replacingInvoiceId = signal<number | null>(null);
  private invoiceSyncPollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly invoiceSyncJobStorageKey = 'fc-invoice-sync-job';
  private readonly walmexCacheKey = 'fc-walmex-invoices';

  syncStatement(event: any) {
    const file = event.target.files[0];
    if (!file) return;
    this.isSyncingStatement.set(true);

    const formData = new FormData();
    formData.append('statementFile', file);

    this.http.post<SyncResult>('/api/invoices/sync-statement', formData, this.authOptions()).subscribe({
      next: res => {
        this.syncResult.set(res);
        this.notify(res.message);
        this.loadInvoices();
        this.loadReconciliation();
        this.isSyncingStatement.set(false);
        event.target.value = '';
      },
      error: error => {
        const message = this.errorMessage(error);
        this.syncResult.set({ message, issues: [{ status: 'error', reason: message }] });
        this.notify(this.errorMessage(error));
        this.isSyncingStatement.set(false);
        event.target.value = '';
      }
    });
  }

  syncInvoices() {
    if (this.isSyncingInvoices()) return;
    this.isSyncingInvoices.set(true);
    this.invoiceSyncProgress.set({ id: '', status: 'queued', total: 0, scanned: 0, processed: 0, skipped: 0, currentFile: '', message: this.language() === 'es' ? 'Iniciando sincronización…' : 'Starting synchronization…', issues: [], details: [] });
    this.http.post<{ jobId: string }>('/api/invoices/sync', {}, this.authOptions()).subscribe({
      next: response => {
        localStorage.setItem(this.invoiceSyncJobStorageKey, response.jobId);
        this.pollInvoiceSync(response.jobId);
      },
      error: error => {
        // If another tab already started the job, attach to its persisted
        // progress instead of starting a second batch or losing visibility.
        if (error.status === 409 && error.error?.jobId) {
          const jobId = String(error.error.jobId);
          localStorage.setItem(this.invoiceSyncJobStorageKey, jobId);
          this.pollInvoiceSync(jobId);
          return;
        }
        this.invoiceSyncProgress.set(null);
        this.notify(this.errorMessage(error));
        this.isSyncingInvoices.set(false);
      }
    });
  }

  private pollInvoiceSync(jobId: string) {
    this.http.get<InvoiceSyncJob>(`/api/invoices/sync/status/${encodeURIComponent(jobId)}`, this.authOptions()).subscribe({
      next: job => {
        this.invoiceSyncProgress.set(job);
        if (job.status === 'queued' || job.status === 'running') {
          this.invoiceSyncPollTimer = setTimeout(() => this.pollInvoiceSync(jobId), 1000);
          return;
        }
        this.syncResult.set({ message: job.message, processed: job.processed, skipped: job.skipped, issues: job.issues || [], details: job.details || [] });
        localStorage.removeItem(this.invoiceSyncJobStorageKey);
        this.loadInvoices();
        this.isSyncingInvoices.set(false);
        this.notify(job.message);
      },
      error: error => {
        if (error.status === 401) {
          this.isSyncingInvoices.set(false);
          this.invoiceSyncProgress.set(null);
          this.notify(this.errorMessage(error));
          return;
        }
        if (error.status === 404) {
          localStorage.removeItem(this.invoiceSyncJobStorageKey);
          this.invoiceSyncProgress.set(null);
          this.isSyncingInvoices.set(false);
          return;
        }
        this.invoiceSyncPollTimer = setTimeout(() => this.pollInvoiceSync(jobId), 1500);
      }
    });
  }

  private resumeInvoiceSyncJob() {
    const jobId = localStorage.getItem(this.invoiceSyncJobStorageKey);
    if (!jobId || this.isSyncingInvoices()) return;
    this.isSyncingInvoices.set(true);
    this.invoiceSyncProgress.set({ id: jobId, status: 'queued', total: 0, scanned: 0, processed: 0, skipped: 0, currentFile: '', message: this.language() === 'es' ? 'Recuperando sincronización…' : 'Resuming synchronization…', issues: [], details: [] });
    this.pollInvoiceSync(jobId);
  }

  invoiceSyncProgressPercent() {
    const progress = this.invoiceSyncProgress();
    if (!progress?.total) return 0;
    return Math.min(100, Math.round((progress.scanned / progress.total) * 100));
  }

  invoiceSyncProgressLabel() {
    const progress = this.invoiceSyncProgress();
    if (!progress) return '';
    if (progress.status === 'queued') return this.language() === 'es' ? 'En cola…' : 'Queued…';
    if (progress.status === 'running') return this.language() === 'es' ? 'Procesando archivos…' : 'Processing files…';
    return progress.status === 'completed' ? (this.language() === 'es' ? 'Completada' : 'Completed') : (this.language() === 'es' ? 'Terminó con error' : 'Finished with an error');
  }

  replaceDuplicateInvoice(issue: SyncIssue) {
    const replacement = issue.replacement;
    if (!replacement || this.replacingInvoiceId() !== null) return;
    if (replacement.kind === 'receiving') {
      this.replaceAmbiguousReceiving(issue);
      return;
    }
    const confirmed = window.confirm(this.language() === 'es'
      ? 'Se reemplazará la factura existente por este PDF. El recibimiento, créditos y aplicaciones existentes se conservarán. ¿Deseas continuar?'
      : 'The existing invoice will be replaced with this PDF. Existing receiving, credits, and applications will be preserved. Continue?');
    if (!confirmed) return;

    if (!replacement.existingInvoiceId) return;
    this.replacingInvoiceId.set(replacement.existingInvoiceId);
    this.http.post<{ message: string; invoice: Invoice }>('/api/invoices/sync/replace', replacement, this.authOptions()).subscribe({
      next: response => {
        this.syncResult.update(result => result ? {
          ...result,
          message: response.message,
          issues: result.issues.map(item => item === issue
            ? { ...item, status: 'warning', reason: this.language() === 'es' ? 'Factura reemplazada correctamente. El recibimiento existente se conservó.' : 'Invoice replaced successfully. The existing receiving was preserved.', replacement: undefined }
            : item)
        } : result);
        this.notify(response.message);
        this.loadInvoices();
        this.replacingInvoiceId.set(null);
      },
      error: error => {
        this.notify(this.errorMessage(error));
        this.replacingInvoiceId.set(null);
      }
    });
  }

  private replaceAmbiguousReceiving(issue: SyncIssue) {
    const replacement = issue.replacement;
    if (!replacement?.sourceFileId || !replacement.invoiceIds?.length || this.replacingInvoiceId() !== null) return;
    const options = replacement.invoiceOptions || [];
    const choices = options.map(option => `${option.folio} · ${option.client}`).join('\n');
    const selectedFolio = window.prompt(this.language() === 'es'
      ? `Escribe el folio exacto de la factura a la que se asociará el recibimiento:\n\n${choices}`
      : `Enter the exact invoice folio that will receive this document:\n\n${choices}`, options[0]?.folio || '');
    const selected = options.find(option => String(option.folio).trim().toUpperCase() === String(selectedFolio || '').trim().toUpperCase());
    if (!selected) {
      if (selectedFolio !== null) this.notify(this.language() === 'es' ? 'No se seleccionó un folio válido.' : 'A valid invoice folio was not selected.');
      return;
    }
    const confirmed = window.confirm(this.language() === 'es'
      ? `El recibimiento se asociará únicamente a la factura ${selected.folio} y reemplazará su recibimiento actual. ¿Deseas continuar?`
      : `The receiving document will be linked only to invoice ${selected.folio} and replace its current receiving. Continue?`);
    if (!confirmed) return;

    this.replacingInvoiceId.set(-1);
    this.http.post<{ message: string }>('/api/invoices/sync/replace-receiving', {
      sourceFileId: replacement.sourceFileId,
      invoiceIds: [selected.id]
    }, this.authOptions()).subscribe({
      next: response => {
        this.syncResult.update(result => result ? {
          ...result,
          message: response.message,
          issues: result.issues.map(item => item === issue
            ? { ...item, status: 'removed', reason: response.message, replacement: undefined }
            : item)
        } : result);
        this.notify(response.message);
        this.loadInvoices();
        this.replacingInvoiceId.set(null);
      },
      error: error => { this.notify(this.errorMessage(error)); this.replacingInvoiceId.set(null); }
    });
  }

  removeDuplicateSource(issue: SyncIssue) {
    const sourceFileId = issue.replacement?.sourceFileId;
    if (!sourceFileId || this.replacingInvoiceId() !== null) return;
    const confirmed = window.confirm(this.language() === 'es'
      ? 'Se eliminará únicamente este PDF de la carpeta de sincronización. La factura registrada y su recibimiento no se tocarán. ¿Deseas continuar?'
      : 'Only this PDF will be deleted from the synchronization folder. The registered invoice and its receiving will not be changed. Continue?');
    if (!confirmed) return;

    this.replacingInvoiceId.set(issue.replacement?.existingInvoiceId || -1);
    this.http.post<{ message: string }>('/api/invoices/sync/remove', { sourceFileId }, this.authOptions()).subscribe({
      next: response => {
        this.syncResult.update(result => result ? {
          ...result,
          issues: result.issues.map(item => item === issue
            ? { ...item, status: 'removed', reason: this.language() === 'es' ? 'PDF eliminado de la carpeta de sincronización. La factura registrada y su recibimiento no fueron modificados.' : 'PDF removed from the synchronization folder. The registered invoice and receiving were not changed.', replacement: undefined }
            : item)
        } : result);
        this.notify(response.message);
        this.replacingInvoiceId.set(null);
      },
      error: error => { this.notify(this.errorMessage(error)); this.replacingInvoiceId.set(null); }
    });
  }

  replaceDuplicateCredit(issue: SyncIssue) {
    const action = issue.creditAction;
    if (!action?.sourceFileId || this.replacingInvoiceId() !== null) return;
    const confirmed = window.confirm(this.language() === 'es'
      ? `Se reemplazará el PDF del crédito ${action.creditNumber}. Sus aplicaciones y balances no cambiarán. ¿Deseas continuar?`
      : `The PDF for credit ${action.creditNumber} will be replaced. Its applications and balances will not change. Continue?`);
    if (!confirmed) return;
    this.replacingInvoiceId.set(-1);
    this.http.post<{ message: string }>('/api/credits/sync/replace', {
      sourceFileId: action.sourceFileId,
      creditNumber: action.creditNumber,
      customer: action.customer || ''
    }, this.authOptions()).subscribe({
      next: response => {
        this.syncResult.update(result => result ? {
          ...result,
          message: response.message,
          issues: result.issues.map(item => item === issue
            ? { ...item, status: 'removed', reason: response.message, creditAction: undefined }
            : item)
        } : result);
        this.notify(response.message);
        this.loadInvoices();
        this.replacingInvoiceId.set(null);
      },
      error: error => { this.notify(this.errorMessage(error)); this.replacingInvoiceId.set(null); }
    });
  }

  deleteDuplicateCredit(issue: SyncIssue) {
    const action = issue.creditAction;
    if (!action?.sourceFileId || this.replacingInvoiceId() !== null) return;
    const confirmed = window.confirm(this.language() === 'es'
      ? `Se eliminará únicamente el PDF duplicado del crédito ${action.creditNumber}. El crédito ya aplicado no cambiará. ¿Deseas continuar?`
      : `Only the duplicate PDF for credit ${action.creditNumber} will be deleted. The applied credit will not change. Continue?`);
    if (!confirmed) return;
    this.replacingInvoiceId.set(-1);
    this.http.post<{ message: string }>('/api/credits/sync/remove', { sourceFileId: action.sourceFileId }, this.authOptions()).subscribe({
      next: response => {
        this.syncResult.update(result => result ? {
          ...result,
          issues: result.issues.map(item => item === issue
            ? { ...item, status: 'removed', reason: response.message, creditAction: undefined }
            : item)
        } : result);
        this.notify(response.message);
        this.replacingInvoiceId.set(null);
      },
      error: error => { this.notify(this.errorMessage(error)); this.replacingInvoiceId.set(null); }
    });
  }

  assignNewCredit(issue: SyncIssue, mode: 'apply' | 'document-only' = 'apply') {
    const action = issue.creditAction || issue.creditAssignment;
    if (!action?.sourceFileId || this.replacingInvoiceId() !== null) return;
    const options = action.invoiceOptions || [];
    if (!options.length) {
      this.notify(this.language() === 'es' ? 'No hay facturas con saldo disponible para asignar este crédito.' : 'There are no invoices with available balance for this credit.');
      return;
    }
    const choices = options.map(option => `${option.folio} · ${option.client} · ${this.formatMoney(option.balance)}`).join('\n');
    const selectedFolio = window.prompt(this.language() === 'es'
      ? `Escribe el folio exacto de la factura destino:\n\n${choices}`
      : `Enter the exact folio of the destination invoice:\n\n${choices}`, options[0].folio);
    const selected = options.find(option => String(option.folio).trim().toUpperCase() === String(selectedFolio || '').trim().toUpperCase());
    if (!selected) {
      if (selectedFolio !== null) this.notify(this.language() === 'es' ? 'No se seleccionó un folio válido.' : 'A valid invoice folio was not selected.');
      return;
    }
    const confirmed = window.confirm(mode === 'document-only'
      ? (this.language() === 'es'
        ? `Solo se colocará el PDF del crédito ${action.creditNumber || ''} en la factura ${selected.folio}. No se modificará ningún balance ni se distribuirá el monto. ¿Deseas continuar?`
        : `Only the credit PDF ${action.creditNumber || ''} will be attached to invoice ${selected.folio}. No balance will change and no amount will be distributed. Continue?`)
      : (this.language() === 'es'
        ? `Se aplicará nuevamente $${Number(action.amount).toFixed(2)} comenzando en la factura ${selected.folio}. Si sobra monto, se distribuirá al mismo cliente. ¿Deseas continuar?`
        : `$${Number(action.amount).toFixed(2)} will be applied again starting at invoice ${selected.folio}. Any remainder will be distributed to the same customer. Continue?`));
    if (!confirmed) return;
    this.replacingInvoiceId.set(-1);
    this.http.post<{ message: string }>('/api/credits/sync/assign', { sourceFileId: action.sourceFileId, invoiceId: selected.id, mode }, this.authOptions()).subscribe({
      next: response => {
        this.syncResult.update(result => result ? {
          ...result,
          message: response.message,
          issues: result.issues.map(item => item === issue
            ? { ...item, status: 'removed', reason: response.message, creditAction: undefined, creditAssignment: undefined }
            : item)
        } : result);
        this.notify(response.message);
        this.loadInvoices();
        this.replacingInvoiceId.set(null);
      },
      error: error => { this.notify(this.errorMessage(error)); this.replacingInvoiceId.set(null); }
    });
  }

  syncDetailTargets(detail: SyncDetail) {
    return detail.targets.map(target => `${target.folio} · ${target.client}${target.amount !== undefined ? ` · ${this.formatMoney(target.amount)}` : ''}`).join(' / ');
  }

  checkAllocationFolios(check: CheckRecord) {
    return check.allocations.map(allocation => allocation.folio).join(', ');
  }

  filteredChecks(): CheckRecord[] {
    const from = this.checksDateFrom();
    const to = this.checksDateTo();
    const term = this.checksSearch().trim().toLowerCase();
    const field = this.checksSearchField();
    const rows = this.checks().filter(c => {
      const d = (c.date || '').slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (term) {
        const haystack = field === 'client' ? (c.client || '')
          : field === 'folio' ? this.checkAllocationFolios(c)
          : (c.series || '');
        if (!haystack.toLowerCase().includes(term)) return false;
      }
      return true;
    });
    const key = this.checksSortKey();
    const dir = this.checksSortDir() === 'asc' ? 1 : -1;
    if (key === 'index') return rows;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (key === 'total') cmp = (a.total || 0) - (b.total || 0);
      else if (key === 'date') cmp = (a.date || '').localeCompare(b.date || '');
      else cmp = String(a[key] || '').localeCompare(String(b[key] || ''), 'es', { sensitivity: 'base' });
      return cmp * dir;
    });
  }

  sortChecksBy(key: 'index' | 'date' | 'series' | 'client' | 'total') {
    if (this.checksSortKey() === key) {
      this.checksSortDir.update(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.checksSortKey.set(key);
      this.checksSortDir.set('asc');
    }
    this.checksPage.set(1);
  }

  checksTotalPages(): number {
    return Math.max(1, Math.ceil(this.filteredChecks().length / this.checksPageSize()));
  }

  pagedChecks(): CheckRecord[] {
    const size = this.checksPageSize();
    const start = (Math.min(this.checksPage(), this.checksTotalPages()) - 1) * size;
    return this.filteredChecks().slice(start, start + size);
  }

  checksRangeLabel(): string {
    const total = this.filteredChecks().length;
    if (!total) return '0 - 0 de 0';
    const size = this.checksPageSize();
    const start = (Math.min(this.checksPage(), this.checksTotalPages()) - 1) * size;
    return (start + 1) + ' - ' + Math.min(start + size, total) + ' de ' + total;
  }

  goChecksPage(page: number) {
    this.checksPage.set(Math.min(Math.max(1, page), this.checksTotalPages()));
  }

  setChecksPageSize(size: number) {
    this.checksPageSize.set(Number(size) || 10);
    this.checksPage.set(1);
  }

  onChecksSearch(value: string) {
    this.checksSearch.set(value);
    this.checksPage.set(1);
  }

  allChecksSelected(): boolean {
    const rows = this.pagedChecks();
    if (!rows.length) return false;
    const sel = this.selectedCheckIds();
    return rows.every(r => sel.includes(r.id));
  }

  toggleAllChecks() {
    const rows = this.pagedChecks().map(r => r.id);
    if (this.allChecksSelected()) {
      this.selectedCheckIds.update(list => list.filter(id => !rows.includes(id)));
    } else {
      this.selectedCheckIds.update(list => [...new Set([...list, ...rows])]);
    }
  }

  isCheckSelected(id: number): boolean {
    return this.selectedCheckIds().includes(id);
  }

  toggleCheckSelected(id: number) {
    this.selectedCheckIds.update(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  }

  toggleChecksActionMenu(id: number) {
    this.checksActionMenuId.update(current => (current === id ? null : id));
  }

  creditRowKey(row: any): string {
    return row.invoice.id + '-' + row.credit.creditNumber;
  }

  creditRowDate(row: any): string {
    return String(row.credit.date || row.credit.dateProcessed || '').slice(0, 10);
  }

  filteredCreditRows(): any[] {
    const from = this.creditsDateFrom();
    const to = this.creditsDateTo();
    const term = this.creditsSearch().trim().toLowerCase();
    const field = this.creditsSearchField();
    const rows = this.creditReportRows().filter(row => {
      const d = this.creditRowDate(row);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (term) {
        const haystack = field === 'credit' ? String(row.credit.creditNumber || '')
          : field === 'invoice' ? String(row.invoice.folio || '')
          : field === 'po' ? String(row.invoice.poNumber || '')
          : field === 'guide' ? String(row.credit.guideNumber || row.invoice.guideNumber || '')
          : String(row.invoice.client || '');
        if (!haystack.toLowerCase().includes(term)) return false;
      }
      return true;
    });
    const key = this.creditsSortKey();
    const dir = this.creditsSortDir() === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (key === 'amount') cmp = Number(a.credit.amount || 0) - Number(b.credit.amount || 0);
      else if (key === 'date') cmp = this.creditRowDate(a).localeCompare(this.creditRowDate(b));
      else {
        const pick = (r: any) => key === 'credit' ? String(r.credit.creditNumber || '')
          : key === 'invoice' ? String(r.invoice.folio || '')
          : key === 'po' ? String(r.invoice.poNumber || '')
          : key === 'guide' ? String(r.credit.guideNumber || r.invoice.guideNumber || '')
          : String(r.invoice.client || '');
        cmp = pick(a).localeCompare(pick(b), 'es', { sensitivity: 'base' });
      }
      return cmp * dir;
    });
  }

  sortCreditsBy(key: 'customer' | 'credit' | 'invoice' | 'po' | 'guide' | 'date' | 'amount') {
    if (this.creditsSortKey() === key) {
      this.creditsSortDir.update(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.creditsSortKey.set(key);
      this.creditsSortDir.set('asc');
    }
    this.creditsPage.set(1);
  }

  creditsTotalPages(): number {
    return Math.max(1, Math.ceil(this.filteredCreditRows().length / this.creditsPageSize()));
  }

  pagedCreditRows(): any[] {
    const size = this.creditsPageSize();
    const start = (Math.min(this.creditsPage(), this.creditsTotalPages()) - 1) * size;
    return this.filteredCreditRows().slice(start, start + size);
  }

  creditsRangeLabel(): string {
    const total = this.filteredCreditRows().length;
    if (!total) return '0 - 0 de 0';
    const size = this.creditsPageSize();
    const start = (Math.min(this.creditsPage(), this.creditsTotalPages()) - 1) * size;
    return (start + 1) + ' - ' + Math.min(start + size, total) + ' de ' + total;
  }

  goCreditsPage(page: number) {
    this.creditsPage.set(Math.min(Math.max(1, page), this.creditsTotalPages()));
  }

  setCreditsPageSize(size: number) {
    this.creditsPageSize.set(Number(size) || 10);
    this.creditsPage.set(1);
  }

  onCreditsSearch(value: string) {
    this.creditsSearch.set(value);
    this.creditsPage.set(1);
  }

  creditsFiltersActive(): boolean {
    return !!(this.creditsSearch() || this.creditsDateFrom() || this.creditsDateTo());
  }

  clearCreditsFilters() {
    this.creditsSearch.set('');
    this.creditsDateFrom.set('');
    this.creditsDateTo.set('');
    this.creditsPage.set(1);
  }

  creditsFilteredTotal(): number {
    return this.filteredCreditRows().reduce((sum, r) => sum + Number(r.credit.amount || 0), 0);
  }

  allCreditsSelected(): boolean {
    const rows = this.pagedCreditRows();
    if (!rows.length) return false;
    const sel = this.selectedCreditKeys();
    return rows.every(r => sel.includes(this.creditRowKey(r)));
  }

  toggleAllCredits() {
    const keys = this.pagedCreditRows().map(r => this.creditRowKey(r));
    if (this.allCreditsSelected()) {
      this.selectedCreditKeys.update(list => list.filter(k => !keys.includes(k)));
    } else {
      this.selectedCreditKeys.update(list => [...new Set([...list, ...keys])]);
    }
  }

  isCreditSelected(row: any): boolean {
    return this.selectedCreditKeys().includes(this.creditRowKey(row));
  }

  toggleCreditSelected(row: any) {
    const key = this.creditRowKey(row);
    this.selectedCreditKeys.update(list => list.includes(key) ? list.filter(x => x !== key) : [...list, key]);
  }

  checksGrandTotal(): number {
    return this.filteredChecks().reduce((sum, c) => sum + (c.total || 0), 0);
  }

  checksDateFilterActive(): boolean {
    return !!(this.checksDateFrom() || this.checksDateTo());
  }

  toggleCheckExpand(id: number) {
    this.expandedChecks.update(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  }

  isCheckExpanded(id: number): boolean {
    return this.expandedChecks().includes(id);
  }

  // Devuelve las asignaciones enriquecidas con PO, cliente y % del total.
  checkAllocationDetails(check: CheckRecord) {
    const total = Number(check.total) || 0;
    return (check.allocations || []).map(a => {
      const invoice = this.invoices().find(inv => String(inv.id) === String(a.invoiceId));
      const amount = Number(a.amount) || 0;
      return {
        folio: a.folio || invoice?.folio || String(a.invoiceId),
        poNumber: invoice?.poNumber || '',
        amount,
        balance: invoice ? this.invoiceBalance(invoice) : null,
        percent: total > 0 ? Math.round((amount / total) * 100) : 0
      };
    });
  }

  openCheckEditor(check: CheckRecord) {
    const allocations = (check.allocations || []).map(a => {
      const invoice = this.invoices().find(inv => String(inv.id) === String(a.invoiceId));
      return {
        invoiceId: a.invoiceId,
        folio: a.folio || invoice?.folio || String(a.invoiceId),
        poNumber: invoice?.poNumber || '',
        amount: Number(a.amount) || 0
      };
    });
    this.editingCheck.set(check);
    this.editCheckForm.set({ date: (check.date || '').slice(0, 10), series: check.series || '', allocations });
    this.showCheckEditor.set(true);
  }

  editCheckTotal(): number {
    return this.editCheckForm().allocations.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  }

  setEditCheckDate(value: string) {
    this.editCheckForm.update(f => ({ ...f, date: value }));
  }

  setEditCheckSeries(value: string) {
    this.editCheckForm.update(f => ({ ...f, series: value }));
  }

  updateEditAllocationAmount(invoiceId: number | string, value: any) {
    const amount = Number(value) || 0;
    this.editCheckForm.update(f => ({
      ...f,
      allocations: f.allocations.map(a => a.invoiceId === invoiceId ? { ...a, amount } : a)
    }));
  }

  removeEditAllocation(invoiceId: number | string) {
    const alloc = this.editCheckForm().allocations.find(a => a.invoiceId === invoiceId);
    const folio = alloc?.folio || invoiceId;
    const msg = this.language() === 'es'
      ? `¿Quitar la factura ${folio} de este cheque? El saldo aplicado se devolverá al guardar los cambios.`
      : `Remove invoice ${folio} from this check? The applied balance will be restored when you save.`;
    if (!confirm(msg)) return;
    this.editCheckForm.update(f => ({ ...f, allocations: f.allocations.filter(a => a.invoiceId !== invoiceId) }));
  }

  saveCheckChanges() {
    const check = this.editingCheck();
    if (!check) return;
    const form = this.editCheckForm();
    const allocations = form.allocations.filter(a => a.amount > 0).map(a => ({ invoiceId: a.invoiceId, amount: a.amount }));
    if (!allocations.length) {
      this.notify(this.language() === 'es' ? 'El cheque debe tener al menos una factura con monto.' : 'The check must keep at least one invoice with an amount.');
      return;
    }
    this.loading.set(true);
    this.http.patch<{ message: string; check: CheckRecord }>(`/api/checks/${check.id}`, {
      date: form.date, series: form.series, allocations
    }, this.authOptions()).subscribe({
      next: response => {
        this.checks.update(items => items.map(c => c.id === check.id ? response.check : c));
        this.notify(response.message);
        this.showCheckEditor.set(false);
        this.editingCheck.set(null);
        this.loadInvoices();
        this.loading.set(false);
      },
      error: error => { this.notify(this.errorMessage(error)); this.loading.set(false); }
    });
  }

  deleteCheck(check: CheckRecord) {
    const confirmMsg = this.language() === 'es'
      ? `¿Eliminar el cheque ${check.series}? Se restaurará el saldo aplicado a las facturas.`
      : `Delete check ${check.series}? The balance applied to invoices will be restored.`;
    if (!confirm(confirmMsg)) return;
    this.loading.set(true);
    this.http.delete<{ message: string }>(`/api/checks/${check.id}`, this.authOptions()).subscribe({
      next: response => {
        this.checks.update(items => items.filter(c => c.id !== check.id));
        this.notify(response.message);
        this.loadInvoices();
        this.loading.set(false);
      },
      error: error => { this.notify(this.errorMessage(error)); this.loading.set(false); }
    });
  }

  clearChecksDateFilter() {
    this.checksDateFrom.set('');
    this.checksDateTo.set('');
  }

  toggleChecksExportMenu() {
    this.checksExportMenuOpen.set(!this.checksExportMenuOpen());
    this.checksDateMenuOpen.set(false);
  }

  toggleChecksDateMenu() {
    this.checksDateMenuOpen.set(!this.checksDateMenuOpen());
    this.checksExportMenuOpen.set(false);
  }

  // ── Mini calendario de rango ──
  private ymd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  checksCalMonthLabel(): string {
    const isSpanish = this.language() === 'es';
    return this.checksCalMonth().toLocaleDateString(isSpanish ? 'es' : 'en', { month: 'long', year: 'numeric' });
  }

  checksCalWeekdays(): string[] {
    return this.language() === 'es'
      ? ['D', 'L', 'M', 'M', 'J', 'V', 'S']
      : ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  }

  checksCalDays(): ({ ymd: string; day: number; inRange: boolean; isStart: boolean; isEnd: boolean; blank: boolean })[] {
    const base = this.checksCalMonth();
    const year = base.getFullYear();
    const month = base.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const from = this.checksDateFrom();
    const to = this.checksDateTo();
    const cells: any[] = [];
    for (let i = 0; i < firstDay; i++) cells.push({ blank: true, ymd: '', day: 0, inRange: false, isStart: false, isEnd: false });
    for (let d = 1; d <= daysInMonth; d++) {
      const key = this.ymd(new Date(year, month, d));
      const isStart = !!from && key === from;
      const isEnd = !!to && key === to;
      const inRange = !!from && !!to && key >= from && key <= to;
      cells.push({ blank: false, ymd: key, day: d, inRange, isStart, isEnd });
    }
    return cells;
  }

  checksCalPrev() {
    const m = new Date(this.checksCalMonth());
    m.setMonth(m.getMonth() - 1);
    this.checksCalMonth.set(m);
  }

  checksCalNext() {
    const m = new Date(this.checksCalMonth());
    m.setMonth(m.getMonth() + 1);
    this.checksCalMonth.set(m);
  }

  checksCalPick(key: string) {
    const from = this.checksDateFrom();
    const to = this.checksDateTo();
    if (!from || (from && to)) {
      // empezar nuevo rango
      this.checksDateFrom.set(key);
      this.checksDateTo.set('');
    } else if (key < from) {
      this.checksDateFrom.set(key);
    } else {
      this.checksDateTo.set(key);
    }
  }

  private xlsxStyleModule: any = null;

  private async loadXlsxStyle() {
    if (!this.xlsxStyleModule) {
      const loaded: any = await import('xlsx-js-style');
      this.xlsxStyleModule = loaded?.utils ? loaded : loaded?.default;
    }
    return this.xlsxStyleModule;
  }

  async exportChecksExcel() {
    const XLSXStyle = await this.loadXlsxStyle();
    this.checksExportMenuOpen.set(false);
    const isSpanish = this.language() === 'es';
    const rows = this.filteredChecks();
    const header = isSpanish
      ? ['#', 'Fecha', 'Serie', 'Cliente', 'Total', 'Facturas aplicadas']
      : ['#', 'Date', 'Series', 'Customer', 'Total', 'Applied invoices'];
    const data: (string | number)[][] = [header];
    rows.forEach((c, i) => {
      data.push([i + 1, this.formatDate(c.date), c.series, c.client, c.total, this.checkAllocationFolios(c)]);
    });
    data.push(['', '', '', '', this.checksGrandTotal(), isSpanish ? 'TOTAL' : 'GRAND TOTAL']);

    const ws = XLSXStyle.utils.aoa_to_sheet(data);
    const range = XLSXStyle.utils.decode_range(ws['!ref'] as string);
    for (let c = range.s.c; c <= range.e.c; c++) {
      const ref = XLSXStyle.utils.encode_cell({ r: 0, c });
      if (ws[ref]) ws[ref].s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0E7079' } }, alignment: { horizontal: 'center' } };
    }
    const lastRow = data.length - 1;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const ref = XLSXStyle.utils.encode_cell({ r: lastRow, c });
      if (ws[ref]) ws[ref].s = { font: { bold: true, color: { rgb: '145C36' } }, fill: { fgColor: { rgb: 'EAF7EF' } } };
    }
    ws['!cols'] = [{ wch: 5 }, { wch: 14 }, { wch: 12 }, { wch: 34 }, { wch: 14 }, { wch: 40 }];
    const wb = XLSXStyle.utils.book_new();
    XLSXStyle.utils.book_append_sheet(wb, ws, isSpanish ? 'Cheques' : 'Checks');
    XLSXStyle.writeFile(wb, `reporte-cheques-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  exportChecksPdf() {
    this.checksExportMenuOpen.set(false);
    const isSpanish = this.language() === 'es';
    const rows = this.filteredChecks();
    const title = isSpanish ? 'Reporte de Cheques' : 'Checks Report';
    const header = isSpanish
      ? ['#', 'Fecha', 'Serie', 'Cliente', 'Total', 'Facturas aplicadas']
      : ['#', 'Date', 'Series', 'Customer', 'Total', 'Applied invoices'];
    const bodyRows = rows.map((c, i) =>
      `<tr><td>${i + 1}</td><td>${this.formatDate(c.date)}</td><td>${c.series}</td><td>${c.client}</td><td style="text-align:right">${this.formatMoney(c.total)}</td><td>${this.checkAllocationFolios(c)}</td></tr>`
    ).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif;color:#1c2a36;margin:24px;}
        h1{font-size:18px;color:#0e7079;margin:0 0 4px;}
        .sub{font-size:11px;color:#6b7684;margin:0 0 16px;}
        table{width:100%;border-collapse:collapse;font-size:11px;}
        th{background:#0e7079;color:#fff;padding:6px 8px;text-align:left;}
        td{padding:5px 8px;border-bottom:1px solid #e5e9ee;}
        tr:nth-child(even) td{background:#f7f8fa;}
        .total-row{font-weight:bold;background:#eaf7ef!important;color:#145c36;}
        .total-row td{background:#eaf7ef!important;}
      </style></head><body>
      <h1>Pacifica Produce LLC — ${title}</h1>
      <p class="sub">${isSpanish ? 'Generado' : 'Generated'}: ${new Date().toLocaleString()} · ${rows.length} ${isSpanish ? 'cheques' : 'checks'}</p>
      <table><thead><tr>${header.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${bodyRows}
      <tr class="total-row"><td colspan="4"></td><td style="text-align:right">${this.formatMoney(this.checksGrandTotal())}</td><td>${isSpanish ? 'TOTAL' : 'GRAND TOTAL'}</td></tr>
      </tbody></table></body></html>`;
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(() => win.print(), 300);
    }
  }

  creditReportGrandTotal(): number {
    return this.creditReportRows().reduce((sum, r) => sum + (r.credit?.amount || 0), 0);
  }

  creditReportUniqueCustomers(): number {
    const set = new Set(this.creditReportRows().map(r => r.invoice.client));
    return set.size;
  }

  customerInitials(name: string): string {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  customerColor(name: string): string {
    if (!name) return '#94a3b8';
    const colors = ['#1a6640', '#2563eb', '#c2410c', '#7c3aed', '#0891b2', '#be185d', '#4d7c0f', '#b45309'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  onCheckClient(value: string) {
    this.checkClient.set(this.customerDisplayName(value));
    this.selectedCheckInvoiceIds.set([]);
    this.checkInvoiceAmounts.set({});
  }

  onCheckSeries(value: string) {
    this.checkSeries.set(value);
    if (!value.trim()) {
      this.checkClient.set('');
      this.selectedCheckInvoiceIds.set([]);
      this.checkInvoiceAmounts.set({});
    }
  }

  focusNextCheckField(event: KeyboardEvent, next: HTMLElement) {
    event.preventDefault();
    setTimeout(() => next.focus());
  }

  submitCheckFromKeyboard(event: KeyboardEvent) {
    event.preventDefault();
    this.saveCheck();
  }

  toggleCheckInvoice(invoiceId: number | string) {
    const alreadySelected = this.selectedCheckInvoiceIds().includes(invoiceId);
    if (alreadySelected) {
      this.selectedCheckInvoiceIds.update(ids => ids.filter(id => id !== invoiceId));
      this.checkInvoiceAmounts.update(map => { const next = { ...map }; delete next[String(invoiceId)]; return next; });
      return;
    }
    const invoice = this.checkInvoices().find(inv => inv.id === invoiceId);
    if (!invoice) return;
    const balance = this.invoiceBalance(invoice);
    const total = Number(this.checkTotal() || 0);
    // Si aún no hay total de cheque capturado, sugiere el saldo completo; si ya hay total,
    // sugiere solo lo que falte por repartir (puede ser $0 si el cheque ya quedó cubierto).
    const suggested = total > 0
      ? Number(Math.max(0, Math.min(balance, total - this.checkSelectedBalance())).toFixed(2))
      : Number(balance.toFixed(2));
    this.selectedCheckInvoiceIds.update(ids => [...ids, invoiceId]);
    this.checkInvoiceAmounts.update(map => ({ ...map, [String(invoiceId)]: suggested }));
  }

  setCheckInvoiceAmount(invoiceId: number | string, rawValue: string | number) {
    const invoice = this.checkInvoices().find(inv => inv.id === invoiceId);
    if (!invoice) return;
    const balance = this.invoiceBalance(invoice);
    let amount = Number(rawValue);
    if (!Number.isFinite(amount) || amount < 0) amount = 0;
    if (amount > balance) amount = balance;
    amount = Number(amount.toFixed(2));
    this.checkInvoiceAmounts.update(map => ({ ...map, [String(invoiceId)]: amount }));
    const isSelected = this.selectedCheckInvoiceIds().includes(invoiceId);
    if (amount > 0 && !isSelected) {
      this.selectedCheckInvoiceIds.update(ids => [...ids, invoiceId]);
    } else if (amount <= 0 && isSelected) {
      this.selectedCheckInvoiceIds.update(ids => ids.filter(id => id !== invoiceId));
    }
  }

  saveCheck() {
    if (!this.checkClient() || !this.checkSeries().trim() || !this.checkTotal() || !this.selectedCheckInvoiceIds().length) {
      this.notify(this.language() === 'es' ? 'Completa los datos del cheque y selecciona al menos una factura.' : 'Complete the check details and select at least one invoice.');
      return;
    }
    if (this.checkUnallocated() > 0.01) {
      this.notify(this.language() === 'es' ? 'El saldo de las facturas seleccionadas no cubre el total del cheque.' : 'The selected invoice balances do not cover the check total.');
      return;
    }
    if (this.checkOverAllocated() > 0.01) {
      this.notify(this.language() === 'es' ? 'El monto repartido entre facturas supera el total del cheque.' : 'The amount allocated across invoices exceeds the check total.');
      return;
    }
    const amounts = this.checkInvoiceAmounts();
    const allocations = this.selectedCheckInvoiceIds()
      .map(id => ({ invoiceId: id, amount: Number(amounts[id]) || 0 }))
      .filter(a => a.amount > 0);
    this.loading.set(true);
    this.http.post<{ message: string; check: CheckRecord }>('/api/checks', {
      date: this.checkDate(), series: this.checkSeries(), client: this.checkClient(), total: Number(this.checkTotal()), invoiceIds: this.selectedCheckInvoiceIds(), allocations
    }, this.authOptions()).subscribe({
      next: response => {
        this.checks.update(items => [response.check, ...items]);
        this.notify(response.message);
        this.checkSeries.set('');
        this.checkTotal.set('');
        this.selectedCheckInvoiceIds.set([]);
        this.checkInvoiceAmounts.set({});
        this.loadInvoices();
        this.loading.set(false);
      },
      error: error => { this.notify(this.errorMessage(error)); this.loading.set(false); }
    });
  }

  async downloadAccountStatement() {
    const invoices = this.accountStatementInvoices();
    if (!invoices.length) {
      this.notify(this.language() === 'es' ? 'No hay facturas para exportar.' : 'There are no invoices to export.');
      return;
    }

    const XLSXStyle = await this.loadXlsxStyle();
    const isSpanish = this.language() === 'es';
    const selectedCustomers = this.statementCustomerFilter();
    const customer = selectedCustomers.length
      ? selectedCustomers.join(', ')
      : (isSpanish ? 'Todos los clientes' : 'All customers');
    const issueDates = invoices.map(invoice => String(invoice.issued || '').slice(0, 10)).filter(Boolean).sort();
    // Exportar exactamente el mismo rango que está aplicado en pantalla.
    // Si no se selecciona una fecha, se conserva el comportamiento actual.
    const periodStart = this.statementDateFrom() || issueDates[0] || new Date().toISOString().slice(0, 10);
    const periodEnd = this.statementDateTo() || new Date().toISOString().slice(0, 10);
    const generatedAt = new Date().toLocaleDateString(isSpanish ? 'es-MX' : 'en-US');
    const totals = this.accountStatementTotals();
    const statementGroups = this.accountStatementGroups();
    const summaryRows = this.accountStatementSummaryRows();
    const summaryTotals = this.accountStatementSummaryTotals();
    // El saldo superior del Excel usa exactamente el mismo total visible en Summary,
    // incluyendo el corte sin cheques y la conversión especial de Walmex.
    const exportBalance = this.accountStatementSummaryGrandTotals().balance;
    const moneyFormat = '"$"#,##0.00';

    // Centro Floricultor va al final, en su propio bloque. Solo se rotula
    // cuando el archivo trae las dos empresas.
    const groupIssuer = (g: { rows: { invoice: Invoice }[] }) =>
      g.rows.length ? this.invoiceIssuerKey(g.rows[0].invoice) : 'pacifica';
    const issuerRank = (key: 'pacifica' | 'centro') => (key === 'centro' ? 1 : 0);
    const orderedGroups = [...statementGroups].sort((a, b) => issuerRank(groupIssuer(a)) - issuerRank(groupIssuer(b)));
    const orderedSummaryRows = [...summaryRows].sort((a, b) => issuerRank(groupIssuer(a.group)) - issuerRank(groupIssuer(b.group)));
    const showIssuerBands = new Set(orderedGroups.map(groupIssuer)).size > 1;
    const issuerTotals = (key: 'pacifica' | 'centro') =>
      orderedGroups.filter(g => groupIssuer(g) === key).reduce((acc, g) => {
        const divisor = g.rows.length && this.isWalmexInvoice(g.rows[0].invoice) ? 17.5 : 1;
        (['0', '1-30', '31-60', '61-90', '90+'] as const).forEach(b => { acc[b] += g.totals[b] / divisor; });
        acc['balance'] += g.totals.balance / divisor;
        return acc;
      }, { '0': 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0, balance: 0 } as Record<string, number>);
    const exportSummaryTotals = (['0', '1-30', '31-60', '61-90', '90+'] as const).reduce((acc, bucket) => {
      acc[bucket] = issuerTotals('pacifica')[bucket] + issuerTotals('centro')[bucket];
      return acc;
    }, { '0': 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0, balance: exportBalance } as Record<string, number>);

    const TEAL_DARK = '0A5660';
    const TEAL = '0E7079';
    const TEAL_DEEP = '0B5E65';
    const TEAL_TEXT = '387F86';
    const TEAL_LIGHT_BG = 'F4FAF9';
    const TEAL_HEADING_BG = 'E2F4F0';
    const TEAL_TOTALS_BG = 'D4EDE8';
    const BORDER_LIGHT = 'DAEAE7';
    const INK = '182A30';
    const BODY_INK = '243D44';
    const LABEL_INK = '7A9EA6';
    const OVERDUE = 'C0392B';
    const WHITE = 'FFFFFF';

    const thinBorder = { style: 'thin', color: { rgb: BORDER_LIGHT } };
    const cellBorder = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

    const companyStyle = { font: { bold: true, sz: 20, color: { rgb: TEAL_DEEP } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: false } };
    const titleStyle = { font: { sz: 12, color: { rgb: TEAL } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: false } };
    const periodStyle = { font: { sz: 10, color: { rgb: TEAL_TEXT } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: false } };
    const metaLabelStyle = { font: { bold: true, sz: 8, color: { rgb: LABEL_INK } }, alignment: { horizontal: 'left', vertical: 'center', wrapText: false, indent: 1 } };
    const metaValueStyle = { font: { bold: true, sz: 11, color: { rgb: INK } }, alignment: { horizontal: 'left', vertical: 'center', wrapText: false, indent: 1 } };
    const detailBalanceLabelStyle = { font: { bold: true, sz: 9, color: { rgb: TEAL_TEXT } }, alignment: { horizontal: 'left', vertical: 'bottom', wrapText: false, indent: 1 } };
    const detailBalanceAmountStyle = { font: { bold: true, sz: 18, color: { rgb: TEAL_DEEP } }, alignment: { horizontal: 'left', vertical: 'top', wrapText: false, indent: 1 } };
    const headerCellStyle = { font: { bold: true, sz: 9, color: { rgb: WHITE } }, fill: { fgColor: { rgb: TEAL } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: false }, border: { top: { style: 'thin', color: { rgb: TEAL_DARK } }, bottom: { style: 'thin', color: { rgb: TEAL_DARK } }, left: { style: 'thin', color: { rgb: TEAL_DARK } }, right: { style: 'thin', color: { rgb: TEAL_DARK } } } };
    const bodyCellStyle = (alt: boolean, align: 'left' | 'center' | 'right' = 'center') => ({ font: { sz: 10, color: { rgb: BODY_INK } }, fill: { fgColor: { rgb: alt ? TEAL_LIGHT_BG : WHITE } }, alignment: { horizontal: align, vertical: 'center', wrapText: false }, border: cellBorder });
    const overdueCellStyle = (alt: boolean) => ({ font: { sz: 10, bold: true, color: { rgb: OVERDUE } }, fill: { fgColor: { rgb: alt ? TEAL_LIGHT_BG : WHITE } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: false }, border: cellBorder });
    const groupHeadingStyle = { font: { bold: true, sz: 11, color: { rgb: TEAL_DEEP } }, fill: { fgColor: { rgb: TEAL_HEADING_BG } }, alignment: { horizontal: 'left', vertical: 'center', wrapText: false, indent: 1 }, border: { left: { style: 'medium', color: { rgb: TEAL } } } };
    const totalsLabelStyle = { font: { bold: true, sz: 10.5, color: { rgb: TEAL_DEEP } }, fill: { fgColor: { rgb: TEAL_TOTALS_BG } }, alignment: { horizontal: 'left', vertical: 'center', wrapText: false, indent: 1 }, border: { top: { style: 'medium', color: { rgb: TEAL } }, bottom: { style: 'medium', color: { rgb: TEAL } } } };
    const totalsMoneyStyle = { font: { bold: true, sz: 10.5, color: { rgb: TEAL_DEEP } }, fill: { fgColor: { rgb: TEAL_TOTALS_BG } }, alignment: { horizontal: 'right', vertical: 'center', wrapText: false }, border: { top: { style: 'medium', color: { rgb: TEAL } }, bottom: { style: 'medium', color: { rgb: TEAL } } } };

    const setCell = (ws: any, r: number, c: number, v: string | number, style?: object, numFmt?: string) => {
      const ref = XLSXStyle.utils.encode_cell({ r, c });
      const cell: any = { v, t: typeof v === 'number' ? 'n' : 's' };
      if (style) cell.s = style;
      if (numFmt) cell.z = numFmt;
      ws[ref] = cell;
    };
    const merge = (ws: any, r1: number, c1: number, r2: number, c2: number) => {
      ws['!merges'] = ws['!merges'] || [];
      ws['!merges'].push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
    };
    const setRowHeight = (ws: any, r: number, hpt: number) => {
      ws['!rows'] = ws['!rows'] || [];
      ws['!rows'][r] = { hpt };
    };

    // Sheet 1: Estado de Cuenta
    const detailCols = 10;
    const wsDetail: any = {};
    let r = 0;
    setCell(wsDetail, r, 0, this.statementHeaderCompany(), companyStyle); merge(wsDetail, r, 0, r, detailCols - 1); setRowHeight(wsDetail, r, 30); r++;
    setCell(wsDetail, r, 0, isSpanish ? 'Estado de Cuenta de Clientes' : 'Customer Account Statement', titleStyle); merge(wsDetail, r, 0, r, detailCols - 1); setRowHeight(wsDetail, r, 18); r++;
    setCell(wsDetail, r, 0, `${isSpanish ? 'Del' : 'From'} ${this.formatDate(periodStart)} ${isSpanish ? 'al' : 'to'} ${this.formatDate(periodEnd)}`, periodStyle); merge(wsDetail, r, 0, r, detailCols - 1); setRowHeight(wsDetail, r, 16); r++;
    setRowHeight(wsDetail, r, 8); r++;
    setCell(wsDetail, r, 0, (isSpanish ? 'Cliente' : 'Customer').toUpperCase(), metaLabelStyle); merge(wsDetail, r, 0, r, 2);
    setCell(wsDetail, r, 3, (isSpanish ? 'Generado' : 'Generated').toUpperCase(), metaLabelStyle); merge(wsDetail, r, 3, r, 5);
    setCell(wsDetail, r, 6, (isSpanish ? 'Moneda' : 'Currency').toUpperCase(), metaLabelStyle); merge(wsDetail, r, 6, r, 9); setRowHeight(wsDetail, r, 14); r++;
    setCell(wsDetail, r, 0, customer, metaValueStyle); merge(wsDetail, r, 0, r, 2);
    setCell(wsDetail, r, 3, generatedAt, metaValueStyle); merge(wsDetail, r, 3, r, 5);
    setCell(wsDetail, r, 6, 'USD', metaValueStyle); merge(wsDetail, r, 6, r, 9); setRowHeight(wsDetail, r, 20); r++;
    setRowHeight(wsDetail, r, 8); r++;
    setCell(wsDetail, r, 0, (isSpanish ? 'Saldo pendiente' : 'Outstanding balance').toUpperCase(), detailBalanceLabelStyle); merge(wsDetail, r, 0, r, detailCols - 1); setRowHeight(wsDetail, r, 16); r++;
    setCell(wsDetail, r, 0, exportBalance, detailBalanceAmountStyle, moneyFormat); merge(wsDetail, r, 0, r, detailCols - 1); setRowHeight(wsDetail, r, 28); r++;
    setRowHeight(wsDetail, r, 10); r++;

    const agingHeaders = isSpanish
      ? ['Vencimiento', 'Fecha', 'Números PO', 'Factura', 'Días de vencimiento', '0 días', '1-30 días', '31-60 días', '61-90 días', 'Más de 90 días']
      : ['Expiration', 'Date', 'PO Numbers', 'Invoice', 'Days expiration', '0 Days', '1-30 Days', '31-60 Days', '61-90 Days', '90 more days'];
    agingHeaders.forEach((header, c) => setCell(wsDetail, r, c, header, headerCellStyle));
    setRowHeight(wsDetail, r, 22); r++;

    const closeDetailIssuer = (key: 'pacifica' | 'centro', row: number) => {
      const t = issuerTotals(key);
      for (let c = 0; c <= 4; c++) {
        setCell(wsDetail, row, c, c === 0 ? `${isSpanish ? 'Total' : 'Total'} ${this.issuerName(key)}` : '', totalsLabelStyle);
      }
      merge(wsDetail, row, 0, row, 4);
      (['0', '1-30', '31-60', '61-90', '90+'] as const).forEach((bucket, i) => {
        setCell(wsDetail, row, 5 + i, t[bucket] || '', totalsMoneyStyle, t[bucket] ? moneyFormat : undefined);
      });
      setRowHeight(wsDetail, row, 20);
      return row + 1;
    };

    let detailIssuer: 'pacifica' | 'centro' | null = null;
    for (const group of orderedGroups) {
      const issuer = groupIssuer(group);
      if (showIssuerBands && issuer !== detailIssuer) {
        if (detailIssuer !== null) { r = closeDetailIssuer(detailIssuer, r); setRowHeight(wsDetail, r, 10); r++; }
        for (let c = 0; c < detailCols; c++) setCell(wsDetail, r, c, c === 0 ? this.issuerName(issuer) : '', headerCellStyle);
        merge(wsDetail, r, 0, r, detailCols - 1); setRowHeight(wsDetail, r, 22); r++;
        detailIssuer = issuer;
      }
      setCell(wsDetail, r, 0, `${isSpanish ? 'Cliente' : 'Customer'}: ${group.customerName}`, groupHeadingStyle);
      merge(wsDetail, r, 0, r, detailCols - 1); setRowHeight(wsDetail, r, 20); r++;
      group.rows.forEach((row, index) => {
        const alt = index % 2 === 1;
        setCell(wsDetail, r, 0, this.formatDate(row.invoice.due), bodyCellStyle(alt, 'left'));
        setCell(wsDetail, r, 1, this.formatDate(row.invoice.issued), bodyCellStyle(alt, 'left'));
        setCell(wsDetail, r, 2, row.invoice.poNumber || '', bodyCellStyle(alt, 'left'));
        setCell(wsDetail, r, 3, row.invoice.folio, bodyCellStyle(alt, 'left'));
        setCell(wsDetail, r, 4, row.daysExpiration > 0 ? row.daysExpiration : '', row.daysExpiration > 0 ? overdueCellStyle(alt) : bodyCellStyle(alt));
        (['0', '1-30', '31-60', '61-90', '90+'] as const).forEach((bucket, i) => {
          const amount = row.bucketAmounts[bucket];
          setCell(wsDetail, r, 5 + i, amount || '', bodyCellStyle(alt, 'right'), amount ? moneyFormat : undefined);
        });
        setRowHeight(wsDetail, r, 18); r++;
      });
      for (let c = 0; c <= 4; c++) {
        setCell(wsDetail, r, c, c === 0 ? (isSpanish ? 'Totales del cliente' : 'Customer totals') : '', totalsLabelStyle);
      }
      merge(wsDetail, r, 0, r, 4);
      (['0', '1-30', '31-60', '61-90', '90+'] as const).forEach((bucket, i) => {
        const amount = group.totals[bucket];
        setCell(wsDetail, r, 5 + i, amount || '', totalsMoneyStyle, amount ? moneyFormat : undefined);
      });
      setRowHeight(wsDetail, r, 20); r++;
      if (group.rows.length && this.isWalmexInvoice(group.rows[0].invoice)) {
        for (let c = 0; c <= 4; c++) {
          setCell(wsDetail, r, c, c === 0 ? 'Customer totals DLLS' : '', totalsLabelStyle);
        }
        merge(wsDetail, r, 0, r, 4);
        (['0', '1-30', '31-60', '61-90', '90+'] as const).forEach((bucket, i) => {
          const amount = this.walmexPesosToDollars(group.totals[bucket]);
          setCell(wsDetail, r, 5 + i, amount || '', totalsMoneyStyle, amount ? moneyFormat : undefined);
        });
        setRowHeight(wsDetail, r, 20); r++;
      }
    }
    if (showIssuerBands && detailIssuer !== null) r = closeDetailIssuer(detailIssuer, r);
    wsDetail['!ref'] = XLSXStyle.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r - 1, c: detailCols - 1 } });
    wsDetail['!cols'] = [{ wch: 13 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 11 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 }];

    // Sheet 2: Resumen
    const summaryCols = 7;
    const wsSummary: any = {};
    let s = 0;
    setCell(wsSummary, s, 0, this.statementHeaderCompany(), companyStyle); merge(wsSummary, s, 0, s, summaryCols - 1); setRowHeight(wsSummary, s, 30); s++;
    setCell(wsSummary, s, 0, isSpanish ? 'Resumen por Cliente' : 'Customer Summary', titleStyle); merge(wsSummary, s, 0, s, summaryCols - 1); setRowHeight(wsSummary, s, 18); s++;
    setCell(wsSummary, s, 0, `${isSpanish ? 'Del' : 'From'} ${this.formatDate(periodStart)} ${isSpanish ? 'al' : 'to'} ${this.formatDate(periodEnd)}`, periodStyle); merge(wsSummary, s, 0, s, summaryCols - 1); setRowHeight(wsSummary, s, 16); s++;
    setRowHeight(wsSummary, s, 8); s++;
    setCell(wsSummary, s, 0, (isSpanish ? 'Cliente' : 'Customer').toUpperCase(), metaLabelStyle); merge(wsSummary, s, 0, s, 1);
    setCell(wsSummary, s, 2, (isSpanish ? 'Generado' : 'Generated').toUpperCase(), metaLabelStyle); merge(wsSummary, s, 2, s, 3);
    setCell(wsSummary, s, 4, (isSpanish ? 'Moneda' : 'Currency').toUpperCase(), metaLabelStyle); merge(wsSummary, s, 4, s, 6); setRowHeight(wsSummary, s, 14); s++;
    setCell(wsSummary, s, 0, customer, metaValueStyle); merge(wsSummary, s, 0, s, 1);
    setCell(wsSummary, s, 2, generatedAt, metaValueStyle); merge(wsSummary, s, 2, s, 3);
    setCell(wsSummary, s, 4, 'USD', metaValueStyle); merge(wsSummary, s, 4, s, 6); setRowHeight(wsSummary, s, 20); s++;
    setRowHeight(wsSummary, s, 8); s++;
    setCell(wsSummary, s, 0, (isSpanish ? 'Saldo pendiente' : 'Outstanding balance').toUpperCase(), detailBalanceLabelStyle); merge(wsSummary, s, 0, s, summaryCols - 1); setRowHeight(wsSummary, s, 16); s++;
    setCell(wsSummary, s, 0, exportBalance, detailBalanceAmountStyle, moneyFormat); merge(wsSummary, s, 0, s, summaryCols - 1); setRowHeight(wsSummary, s, 28); s++;
    setRowHeight(wsSummary, s, 10); s++;

    const summaryHeaders = isSpanish
      ? ['Cliente', '0 días', '1-30 días', '31-60 días', '61-90 días', 'Más de 90 días', 'Total']
      : ['Customer', '0 Days', '1-30 Days', '31-60 Days', '61-90 Days', '90 more days', 'Total'];
    summaryHeaders.forEach((header, c) => setCell(wsSummary, s, c, header, headerCellStyle));
    setRowHeight(wsSummary, s, 22); s++;

    const closeSummaryIssuer = (key: 'pacifica' | 'centro', row: number) => {
      const t = issuerTotals(key);
      setCell(wsSummary, row, 0, `${isSpanish ? 'Total' : 'Total'} ${this.issuerName(key)}`, totalsLabelStyle);
      (['0', '1-30', '31-60', '61-90', '90+'] as const).forEach((bucket, i) => {
        setCell(wsSummary, row, 1 + i, t[bucket] || '', totalsMoneyStyle, t[bucket] ? moneyFormat : undefined);
      });
      setCell(wsSummary, row, 6, t['balance'], totalsMoneyStyle, moneyFormat);
      setRowHeight(wsSummary, row, 20);
      return row + 1;
    };

    let summaryIssuer: 'pacifica' | 'centro' | null = null;
    orderedSummaryRows.forEach((row, index) => {
      const issuer = groupIssuer(row.group);
      if (showIssuerBands && issuer !== summaryIssuer) {
        if (summaryIssuer !== null) { s = closeSummaryIssuer(summaryIssuer, s); setRowHeight(wsSummary, s, 10); s++; }
        for (let c = 0; c < summaryCols; c++) setCell(wsSummary, s, c, c === 0 ? this.issuerName(issuer) : '', headerCellStyle);
        merge(wsSummary, s, 0, s, summaryCols - 1); setRowHeight(wsSummary, s, 22); s++;
        summaryIssuer = issuer;
      }
      const alt = index % 2 === 1;
      setCell(wsSummary, s, 0, row.group.customerName, bodyCellStyle(alt, 'left'));
      (['0', '1-30', '31-60', '61-90', '90+'] as const).forEach((bucket, i) => {
        const amount = row.group.totals[bucket];
        setCell(wsSummary, s, 1 + i, amount || '', bodyCellStyle(alt, 'right'), amount ? moneyFormat : undefined);
      });
      setCell(wsSummary, s, 6, row.group.totals.balance, bodyCellStyle(alt, 'right'), moneyFormat);
      setRowHeight(wsSummary, s, 18); s++;
      if (row.group.rows.length && this.isWalmexInvoice(row.group.rows[0].invoice)) {
        setCell(wsSummary, s, 0, 'Customer totals DLLS', totalsLabelStyle);
        (['0', '1-30', '31-60', '61-90', '90+'] as const).forEach((bucket, i) => {
          const amount = this.walmexPesosToDollars(row.group.totals[bucket]);
          setCell(wsSummary, s, 1 + i, amount || '', totalsMoneyStyle, amount ? moneyFormat : undefined);
        });
        setCell(wsSummary, s, 6, this.walmexPesosToDollars(row.group.totals.balance), totalsMoneyStyle, moneyFormat);
        setRowHeight(wsSummary, s, 20); s++;
      }
    });
    if (showIssuerBands && summaryIssuer !== null) { s = closeSummaryIssuer(summaryIssuer, s); setRowHeight(wsSummary, s, 10); s++; }
    setCell(wsSummary, s, 0, isSpanish ? 'Total general' : 'Grand total', totalsLabelStyle);
    (['0', '1-30', '31-60', '61-90', '90+'] as const).forEach((bucket, i) => {
      const amount = exportSummaryTotals[bucket];
      setCell(wsSummary, s, 1 + i, amount || '', totalsMoneyStyle, amount ? moneyFormat : undefined);
    });
    setCell(wsSummary, s, 6, exportBalance, totalsMoneyStyle, moneyFormat);
    setRowHeight(wsSummary, s, 20); s++;
    wsSummary['!ref'] = XLSXStyle.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: s - 1, c: summaryCols - 1 } });
    wsSummary['!cols'] = [{ wch: 24 }, { wch: 11 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 15 }];

    const workbook = XLSXStyle.utils.book_new();
    XLSXStyle.utils.book_append_sheet(workbook, wsDetail, (isSpanish ? 'Estado de Cuenta' : 'Account Statement').slice(0, 31));
    XLSXStyle.utils.book_append_sheet(workbook, wsSummary, (isSpanish ? 'Resumen' : 'Summary').slice(0, 31));

    const fileCustomer = selectedCustomers.length
      ? selectedCustomers.join('-')
      : (isSpanish ? 'todos-los-clientes' : 'all-customers');
    XLSXStyle.writeFile(workbook, `estado-de-cuenta-${fileCustomer.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}.xlsx`);
  }
  syncCredits() {
    this.isSyncingCredits.set(true);
    this.http.post<SyncResult>('/api/credits/sync', {}, this.authOptions()).subscribe({
      next: res => {
        this.syncResult.set(res);
        this.notify(res.message);
        this.loadInvoices();
        this.isSyncingCredits.set(false);
      },
      error: error => {
        const message = this.errorMessage(error);
        this.syncResult.set({ message, issues: [{ status: 'error', reason: message }] });
        this.notify(message);
        this.isSyncingCredits.set(false);
      }
    });
  }

  /** Al cargar, el filtro cubre desde la factura mas antigua hasta hoy. */
  private initInvoiceDateRange(invoices: Invoice[]) {
    if (this.invoiceRangeInitialized || !invoices.length) return;
    const fechas = invoices.map(invoice => invoice.issued).filter(Boolean).sort();
    if (!fechas.length) return;
    this.dateFrom.set(fechas[0]);
    this.dateTo.set(App.todayIso());
    this.invoiceRangeInitialized = true;
  }

  private loadInvoices(onLoaded?: () => void) {
    this.loading.set(true);
    const pageSize = 100;
    const loadPage = (page: number, accumulated: Invoice[]) => {
      this.http.get<Invoice[] | { items: Invoice[]; total: number }>(`/api/invoices?page=${page}&pageSize=${pageSize}`, this.authOptions()).subscribe({
        next: response => {
          const items = Array.isArray(response) ? response : (response.items || []);
          const invoices = [...accumulated, ...items];
          const total = Array.isArray(response) ? invoices.length : Number(response.total || invoices.length);
          if (invoices.length < total && items.length) {
            loadPage(page + 1, invoices);
            return;
          }
          this.invoices.set(invoices);
          this.initInvoiceDateRange(invoices);
          this.loading.set(false);
          onLoaded?.();
          this.loadWalmexInvoices();
        },
        error: error => {
          this.loading.set(false);
          if (error.status === 401) this.clearSession();
          else this.notify(this.errorMessage(error));
        }
      });
    };
    loadPage(1, []);
  }

  private loadWalmexInvoices() {
    this.http.get<{ invoices: Invoice[]; stale?: boolean }>('/api/walmex/invoices', this.authOptions()).subscribe({
      next: response => {
        const walmex = Array.isArray(response?.invoices) ? response.invoices : [];
        if (walmex.length) sessionStorage.setItem(this.walmexCacheKey, JSON.stringify(walmex));
        if (response?.stale) {
          try {
            const cached = JSON.parse(sessionStorage.getItem(this.walmexCacheKey) || '[]');
            if (Array.isArray(cached)) this.mergeWalmexInvoices(cached);
          } catch { /* ignore invalid cache */ }
          return;
        }
        this.mergeWalmexInvoices(walmex);
      },
      error: error => {
        try {
          const cached = JSON.parse(sessionStorage.getItem(this.walmexCacheKey) || '[]');
          if (shouldUseWalmexCache(error.status) && Array.isArray(cached) && cached.length) this.mergeWalmexInvoices(cached);
          if (!shouldUseWalmexCache(error.status)) {
            sessionStorage.removeItem(this.walmexCacheKey);
            this.invoices.update(current => current.filter(invoice => !this.isWalmexInvoice(invoice)));
          }
        } catch { /* ignore invalid cache */ }
        if (error.status !== 401 && error.status !== 403) return;
      },
    });
  }

  private mergeWalmexInvoices(walmex: Invoice[]) {
    this.invoices.update(current => {
      const regular = current.filter(invoice => !this.isWalmexInvoice(invoice));
      return [...regular, ...walmex].sort((a, b) => String(b.issued || b.id || '').localeCompare(String(a.issued || a.id || '')));
    });
  }

  statementGroupDomId(group: any): string {
    return 'stmt-group-' + String(group.customerCode || group.customerName || '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  }

  statementDefaultSubject(group: any, lang: 'es' | 'en'): string {
    return lang === 'es'
      ? 'Estado de cuenta — ' + group.customerName
      : 'Account statement — ' + group.customerName;
  }

  statementDefaultBody(lang: 'es' | 'en'): string {
    return lang === 'es'
      ? '<p>Estimado cliente,</p><p>Le compartimos su estado de cuenta al {{fecha}}, con un saldo pendiente de <strong>{{saldo}}</strong> en {{facturas}} factura(s) abierta(s).</p><p>Quedamos atentos a cualquier aclaración.</p><p>Saludos cordiales,<br>{{empresa}}</p>'
      : '<p>Dear customer,</p><p>Please find your account statement as of {{fecha}}, with an outstanding balance of <strong>{{saldo}}</strong> across {{facturas}} open invoice(s).</p><p>We remain at your service.</p><p>Best regards,<br>{{empresa}}</p>';
  }

  /**
   * Con que se manda el estado de cuenta de un cliente: destinatarios del
   * cliente y mensaje de la empresa emisora. Lo usan el cuadro manual y el
   * envio masivo, para que uno no se comporte distinto del otro.
   */
  private statementEmailContext(group: any) {
    // el alias agrupa las razones sociales del cliente; la llave no puede
    // salir de la factura que quede primero, porque cambia con el orden
    const aliasKey = this.customerAliasKey(group?.customerName || '');
    const legacyKeys = this.customerLegacyKeys(aliasKey);
    const templates = this.emailTemplates();
    // el mensaje del estado de cuenta se guarda aparte del de la factura: son
    // textos distintos y con campos distintos
    const stmtTemplate = findClientTemplate(templates, 'statement', aliasKey, legacyKeys);
    const invoiceTemplate = findClientTemplate(templates, 'invoice', aliasKey, legacyKeys);
    const issuer = this.groupIssuerKey(group);
    const companyTemplate = templates.find(item => item.clientKey === companyTemplateKey('statement', issuer)) || null;
    const generalTemplate = templates.find(item => item.clientKey === this.emailDefaultTemplateKey) || null;
    // el mensaje lo pone la empresa emisora del saldo
    const message = companyTemplate || stmtTemplate || generalTemplate;
    const template = stmtTemplate || invoiceTemplate || generalTemplate;
    const logoTemplate = companyTemplate || template;
    const admin = this.user()?.role === 'admin';
    const mailLang: 'es' | 'en' = this.language() === 'es' ? 'es' : 'en';
    const agent = this.agentForCustomerName(group?.customerName || '');
    return {
      aliasKey,
      issuer,
      agent,
      // Solo lo capturado para el estado de cuenta: no hereda de la factura ni
      // usa el correo que trae la factura. Ese trae capturas de prueba (como
      // "billdoran@dallas" en el cliente de Portland) y nadie las revisa antes
      // de que salgan. Se captura una vez al enviar y desde ahi queda guardado.
      to: admin ? (stmtTemplate?.to || '') : (this.user()?.email || ''),
      cc: admin ? (stmtTemplate?.cc || '') : '',
      // lo guardado para el cliente manda sobre la plantilla por omision:
      // si el mensaje se escribio en ingles, vuelve en ingles
      subject: message?.subject || this.statementDefaultSubject(group, mailLang),
      bodyHtml: message?.bodyHtml || this.statementDefaultBody(mailLang),
      logo: logoTemplate?.logo || '',
      logoKey: logoTemplate?.clientKey || '',
      clientKey: clientTemplateKey('statement', aliasKey),
      companyKey: companyTemplateKey('statement', issuer),
      companyName: this.issuerName(issuer),
    };
  }

  openStatementEmail(group: any) {
    const invoice: Invoice | undefined = group.rows?.[0]?.invoice;
    if (!invoice) return;
    const context = this.statementEmailContext(group);

    this.stmtEmailGroup.set(group);
    this.stmtEmailTo.set(context.to);
    this.stmtEmailCc.set(context.cc);
    this.emailTemplateCompany.set(context.companyName);
    this.stmtEmailSubject.set(context.subject);
    this.stmtEmailBody.set(context.bodyHtml);
    this.stmtEmailBodyInitial.set(this.stmtEmailBody());
    this.stmtEmailLogo.set(context.logo);
    this.stmtEmailFormat.set('excel');
    const agent = context.agent;
    this.stmtEmailAgent.set(agent);
    this.stmtEmailAgentTo.set(agent?.email || '');
    // el correo se captura en el catalogo de agentes, aqui solo se usa
    this.stmtEmailIncludeAgent.set(!!agent?.email);
    this.stmtEmailSaveTemplate.set(this.user()?.role === 'admin');
    this.stmtEmailPreview.set('');
    this.emailFieldContext.set('statement');
    this.stmtEmailOpen.set(true);
    this.loadEmailTemplateLogo(context.logoKey, 'statement');
    this.tinymceError.set(false);
    this.loadTinymceScript().catch(() => {
      this.notify(this.language() === 'es' ? 'No se pudo cargar el editor de mensajes.' : 'The message editor could not be loaded.');
    });
  }

  closeStatementEmail() {
    if (this.stmtEmailSending()) return;
    this.stmtEmailOpen.set(false);
    this.stmtEmailGroup.set(null);
    this.stmtEmailPreview.set('');
  }

  setStmtEmailFormat(format: 'excel' | 'image') {
    this.stmtEmailFormat.set(format);
    this.stmtEmailPreview.set('');
    if (format === 'image') this.buildStatementImage().then(dataUrl => this.stmtEmailPreview.set(dataUrl || '')).catch(() => {});
  }

  /**
   * Dibuja la tarjeta del cliente en un canvas, con anchos de columna fijos.
   * En pantalla la tabla se estira a todo el ancho disponible y una captura
   * saldria con las columnas muy separadas; aqui se controla el ancho real.
   */
  private async buildStatementImage(): Promise<string> {
    const group = this.stmtEmailGroup();
    if (!group) return '';
    const isSpanish = this.language() === 'es';

    const headers = isSpanish
      ? ['Vencimiento', 'Fecha', 'Números PO', 'Factura', 'Días venc.', '0 días', '1-30 días', '31-60 días', '61-90 días', '+90 días']
      : ['Expiration', 'Date', 'PO Numbers', 'Invoice', 'Days exp.', '0 Days', '1-30 Days', '31-60 Days', '61-90 Days', '90+ Days'];
    const widths = [88, 88, 120, 78, 74, 76, 84, 84, 84, 76];
    const tableWidth = widths.reduce((sum, w) => sum + w, 0);

    const pad = 14;
    const titleH = 26;
    const subtitleH = 18;
    const headH = 26;
    const rowH = 22;
    const totalsH = 26;
    const width = tableWidth + pad * 2;
    const height = pad + titleH + subtitleH + 8 + headH + group.rows.length * rowH + totalsH + pad;

    const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 2));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.scale(scale, scale);
    ctx.textBaseline = 'middle';

    const FONT = '"Nunito Sans", "Segoe UI", Arial, sans-serif';
    const TEAL = '#0e7079';
    const INK = '#29435b';
    const MUTED = '#7a8b94';
    const LINE = '#e6edf1';
    const ALT = '#f8faf9';
    const TOTALS_BG = '#eef8f1';
    const TOTALS_INK = '#187c4a';
    const OVERDUE = '#c0392b';

    // fondo
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // titulo
    let y = pad;
    ctx.fillStyle = INK;
    ctx.font = '700 15px ' + FONT;
    ctx.textAlign = 'left';
    ctx.fillText(group.customerName, pad, y + titleH / 2);
    y += titleH;

    ctx.fillStyle = MUTED;
    ctx.font = '11px ' + FONT;
    const subtitle = this.groupIssuerName(group) + '  ·  '
      + group.rows.length + ' ' + (isSpanish ? 'facturas abiertas' : 'open invoices')
      + '  ·  ' + (isSpanish ? 'Saldo' : 'Balance') + ' ' + this.formatMoney(group.totals.balance);
    ctx.fillText(subtitle, pad, y + subtitleH / 2);
    y += subtitleH + 8;

    // encabezado
    ctx.fillStyle = TEAL;
    ctx.fillRect(pad, y, tableWidth, headH);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 10px ' + FONT;
    let x = pad;
    headers.forEach((header, i) => {
      ctx.textAlign = i >= 5 ? 'right' : 'left';
      const tx = i >= 5 ? x + widths[i] - 6 : x + 6;
      ctx.fillText(header, tx, y + headH / 2);
      x += widths[i];
      if (i < headers.length - 1) {
        ctx.fillStyle = 'rgba(255,255,255,.28)';
        ctx.fillRect(x - 0.5, y + 4, 1, headH - 8);
        ctx.fillStyle = '#ffffff';
      }
    });
    y += headH;

    // filas
    ctx.font = '11px ' + FONT;
    group.rows.forEach((row: any, index: number) => {
      if (index % 2 === 1) {
        ctx.fillStyle = ALT;
        ctx.fillRect(pad, y, tableWidth, rowH);
      }
      const cells = [
        this.formatDate(row.invoice.due),
        this.formatDate(row.invoice.issued),
        row.invoice.poNumber || '',
        row.invoice.folio,
        row.daysExpiration > 0 ? String(row.daysExpiration) : '',
        row.bucketAmounts['0'] ? this.formatMoney(row.bucketAmounts['0']) : '',
        row.bucketAmounts['1-30'] ? this.formatMoney(row.bucketAmounts['1-30']) : '',
        row.bucketAmounts['31-60'] ? this.formatMoney(row.bucketAmounts['31-60']) : '',
        row.bucketAmounts['61-90'] ? this.formatMoney(row.bucketAmounts['61-90']) : '',
        row.bucketAmounts['90+'] ? this.formatMoney(row.bucketAmounts['90+']) : ''
      ];
      x = pad;
      cells.forEach((text, i) => {
        if (text) {
          ctx.fillStyle = i === 4 && row.daysExpiration > 0 ? OVERDUE : INK;
          ctx.font = (i === 4 && row.daysExpiration > 0 ? '700 11px ' : '11px ') + FONT;
          ctx.textAlign = i >= 5 ? 'right' : 'left';
          const tx = i >= 5 ? x + widths[i] - 6 : x + 6;
          ctx.fillText(this.fitCanvasText(ctx, text, widths[i] - 12), tx, y + rowH / 2);
        }
        x += widths[i];
      });
      ctx.fillStyle = LINE;
      ctx.fillRect(pad, y + rowH - 0.5, tableWidth, 1);
      y += rowH;
    });

    // totales
    ctx.fillStyle = TOTALS_BG;
    ctx.fillRect(pad, y, tableWidth, totalsH);
    ctx.fillStyle = TOTALS_INK;
    ctx.fillRect(pad, y, tableWidth, 1.5);
    ctx.font = '700 11px ' + FONT;
    ctx.textAlign = 'left';
    ctx.fillText(isSpanish ? 'Totales del cliente' : 'Customer totals', pad + 6, y + totalsH / 2);
    x = pad + widths.slice(0, 5).reduce((sum, w) => sum + w, 0);
    (['0', '1-30', '31-60', '61-90', '90+'] as const).forEach((bucket, i) => {
      const amount = group.totals[bucket];
      if (amount) {
        ctx.textAlign = 'right';
        ctx.fillText(this.formatMoney(amount), x + widths[5 + i] - 6, y + totalsH / 2);
      }
      x += widths[5 + i];
    });

    return canvas.toDataURL('image/png');
  }

  /** Recorta con puntos suspensivos si el texto no cabe en la columna. */
  private fitCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let clipped = text;
    while (clipped.length > 1 && ctx.measureText(clipped + '…').width > maxWidth) {
      clipped = clipped.slice(0, -1);
    }
    return clipped + '…';
  }

  /** Excel de un solo cliente, con los mismos colores del estado de cuenta. */
  private async buildStatementExcelBase64(group: any): Promise<string> {
    const XLSXStyle = await this.loadXlsxStyle();
    const isSpanish = this.language() === 'es';
    const moneyFormat = '"$"#,##0.00';
    const TEAL = '0E7079';
    const TEAL_DEEP = '0B5E65';
    const WHITE = 'FFFFFF';
    const BODY_INK = '243D44';
    const ALT_BG = 'F4FAF9';
    const TOTALS_BG = 'D4EDE8';

    const headers = isSpanish
      ? ['Vencimiento', 'Fecha', 'Números PO', 'Factura', 'Días de vencimiento', '0 días', '1-30 días', '31-60 días', '61-90 días', 'Más de 90 días']
      : ['Expiration', 'Date', 'PO Numbers', 'Invoice', 'Days expiration', '0 Days', '1-30 Days', '31-60 Days', '61-90 Days', '90 more days'];

    const data: any[][] = [];
    // la empresa sale de las facturas del cliente, no del filtro activo:
    // al enviar desde 'Todas' debe decir la que realmente le factura
    data.push([this.groupIssuerName(group)]);
    data.push([isSpanish ? 'Estado de Cuenta' : 'Account Statement']);
    data.push([group.customerName]);
    data.push([]);
    data.push(headers);
    for (const row of group.rows) {
      data.push([
        this.formatDate(row.invoice.due),
        this.formatDate(row.invoice.issued),
        row.invoice.poNumber || '',
        row.invoice.folio,
        row.daysExpiration > 0 ? row.daysExpiration : '',
        row.bucketAmounts['0'] || '',
        row.bucketAmounts['1-30'] || '',
        row.bucketAmounts['31-60'] || '',
        row.bucketAmounts['61-90'] || '',
        row.bucketAmounts['90+'] || ''
      ]);
    }
    data.push([
      isSpanish ? 'Totales del cliente' : 'Customer totals', '', '', '', '',
      group.totals['0'] || '', group.totals['1-30'] || '', group.totals['31-60'] || '',
      group.totals['61-90'] || '', group.totals['90+'] || ''
    ]);

    const ws = XLSXStyle.utils.aoa_to_sheet(data);
    const at = (r: number, c: number) => XLSXStyle.utils.encode_cell({ r, c });
    const headerRow = 4;
    const totalsRow = data.length - 1;

    // mismos estilos centrados que el formato completo que se descarga
    const centered = { horizontal: 'center', vertical: 'center', wrapText: false };
    if (ws[at(0, 0)]) ws[at(0, 0)].s = { font: { bold: true, sz: 20, color: { rgb: TEAL_DEEP } }, alignment: centered };
    if (ws[at(1, 0)]) ws[at(1, 0)].s = { font: { sz: 12, color: { rgb: TEAL } }, alignment: centered };
    if (ws[at(2, 0)]) ws[at(2, 0)].s = { font: { bold: true, sz: 12, color: { rgb: BODY_INK } }, alignment: centered };
    ws['!rows'] = [{ hpt: 30 }, { hpt: 18 }, { hpt: 20 }, { hpt: 8 }];

    for (let c = 0; c < headers.length; c++) {
      if (ws[at(headerRow, c)]) {
        ws[at(headerRow, c)].s = { font: { bold: true, sz: 9, color: { rgb: WHITE } }, fill: { fgColor: { rgb: TEAL } }, alignment: { horizontal: 'center', vertical: 'center' } };
      }
    }
    for (let r = headerRow + 1; r < totalsRow; r++) {
      const alt = (r - headerRow) % 2 === 0;
      for (let c = 0; c < headers.length; c++) {
        const ref = at(r, c);
        if (!ws[ref]) continue;
        ws[ref].s = { font: { sz: 10, color: { rgb: BODY_INK } }, fill: { fgColor: { rgb: alt ? ALT_BG : WHITE } }, alignment: { horizontal: c >= 5 ? 'right' : 'left', vertical: 'center' } };
        if (c >= 5 && typeof ws[ref].v === 'number') ws[ref].z = moneyFormat;
      }
    }
    for (let c = 0; c < headers.length; c++) {
      const ref = at(totalsRow, c);
      if (!ws[ref]) continue;
      ws[ref].s = { font: { bold: true, sz: 10.5, color: { rgb: TEAL_DEEP } }, fill: { fgColor: { rgb: TOTALS_BG } }, alignment: { horizontal: c >= 5 ? 'right' : 'left', vertical: 'center' } };
      if (c >= 5 && typeof ws[ref].v === 'number') ws[ref].z = moneyFormat;
    }
    ws['!cols'] = [{ wch: 13 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 11 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 }];
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 9 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 9 } },
      { s: { r: totalsRow, c: 0 }, e: { r: totalsRow, c: 4 } }
    ];

    const wb = XLSXStyle.utils.book_new();
    XLSXStyle.utils.book_append_sheet(wb, ws, (isSpanish ? 'Estado de Cuenta' : 'Account Statement').slice(0, 31));
    return XLSXStyle.write(wb, { bookType: 'xlsx', type: 'base64' });
  }

  async sendStatementEmail() {
    const group = this.stmtEmailGroup();
    if (!group || this.stmtEmailSending()) return;
    if (!this.stmtEmailTo().trim()) {
      this.notify(this.language() === 'es' ? 'Captura al menos un destinatario.' : 'Enter at least one recipient.');
      return;
    }
    const isSpanish = this.language() === 'es';
    const slug = String(group.customerName || 'cliente').toLowerCase().replace(/[^a-z0-9]+/gi, '-');
    this.stmtEmailSending.set(true);
    try {
      let attachmentBase64 = '';
      let attachmentName = '';
      if (this.stmtEmailFormat() === 'excel') {
        attachmentBase64 = await this.buildStatementExcelBase64(group);
        attachmentName = 'estado-de-cuenta-' + slug + '.xlsx';
      } else {
        const dataUrl = this.stmtEmailPreview() || await this.buildStatementImage();
        if (!dataUrl) throw new Error(isSpanish ? 'No se pudo generar la imagen.' : 'The image could not be generated.');
        attachmentBase64 = dataUrl.split(',')[1] || '';
        attachmentName = 'estado-de-cuenta-' + slug + '.png';
      }

      const invoice: Invoice = group.rows[0].invoice;

      // el correo del agente viaja en copia, y si lo editaron se guarda
      const agent = this.stmtEmailAgent();
      const agentEmail = this.stmtEmailAgentTo().trim();
      const ccParts = [this.stmtEmailCc().trim()];
      if (this.stmtEmailIncludeAgent() && agentEmail) ccParts.push(agentEmail);
      const cc = ccParts.filter(Boolean).join(', ');
      this.http.post<{ message: string }>('/api/account-statement/send-email', {
        to: this.stmtEmailTo(),
        cc,
        subject: this.stmtEmailSubject(),
        bodyHtml: this.stmtEmailBody(),
        logo: this.stmtEmailLogo(),
        attachmentBase64,
        attachmentName,
        placeholders: this.statementPlaceholderValues(group),
        issuer: this.groupIssuerKey(group),
        saveTemplate: this.stmtEmailSaveTemplate(),
        clientKey: clientTemplateKey('statement', this.customerAliasKey(group.customerName)),
        companyKey: companyTemplateKey('statement', this.groupIssuerKey(group)),
        client: group.customerName
      }, this.authOptions()).subscribe({
        next: response => {
          this.notify(response.message);
          this.stmtEmailSending.set(false);
          this.stmtEmailOpen.set(false);
          this.stmtEmailGroup.set(null);
          if (this.user()?.role === 'admin' && this.stmtEmailSaveTemplate()) this.loadEmailTemplates();
        },
        error: error => { this.notify(this.errorMessage(error)); this.stmtEmailSending.set(false); }
      });
    } catch (error: any) {
      this.notify(error?.message || (isSpanish ? 'No se pudo preparar el envío.' : 'The email could not be prepared.'));
      this.stmtEmailSending.set(false);
    }
  }

  private loadAgents() {
    this.http.get<Agent[]>('/api/agents', this.authOptions()).subscribe({
      next: agents => this.agents.set(agents),
      error: error => this.notify(this.errorMessage(error))
    });
  }

  filteredAgents(): Agent[] {
    const term = this.agentSearch().trim().toLowerCase();
    if (!term) return this.agents();
    return this.agents().filter(agent => agent.name.toLowerCase().includes(term)
      || (agent.clients || []).some(client => client.toLowerCase().includes(term)));
  }

  agentClientsLabel(agent: Agent): string {
    const total = (agent.clients || []).length;
    if (!total) return this.language() === 'es' ? 'Sin clientes' : 'No customers';
    return total + ' ' + (this.language() === 'es'
      ? (total === 1 ? 'cliente' : 'clientes')
      : (total === 1 ? 'customer' : 'customers'));
  }

  /** Clientes que ya tiene otro agente, para no asignarlos dos veces. */
  agentOfCustomer(customer: string): string {
    const editingId = this.editingAgent()?.id;
    const owner = this.agents().find(agent => agent.id !== editingId && (agent.clients || []).includes(customer));
    return owner ? owner.name : '';
  }

  unassignedCustomerCount(): number {
    const taken = new Set(this.agents().flatMap(agent => agent.clients || []));
    return this.customerOptions().filter(customer => !taken.has(customer)).length;
  }

  openAgentForm(agent?: Agent) {
    this.editingAgent.set(agent || null);
    this.agentForm = agent
      ? { name: agent.name, email: agent.email || '', clients: [...(agent.clients || [])] }
      : { name: '', email: '', clients: [] };
    this.showAgentForm.set(true);
  }

  closeAgentForm() {
    this.showAgentForm.set(false);
    this.editingAgent.set(null);
  }

  saveAgent() {
    const name = this.agentForm.name.trim();
    if (!name) {
      this.notify(this.language() === 'es' ? 'Escribe el nombre del agente.' : 'Enter the agent name.');
      return;
    }
    const payload = { name, email: this.agentForm.email.trim(), clients: this.agentForm.clients };
    const editing = this.editingAgent();
    const request = editing
      ? this.http.put<Agent>('/api/agents/' + editing.id, payload, this.authOptions())
      : this.http.post<Agent>('/api/agents', payload, this.authOptions());
    this.agentSaving.set(true);
    request.subscribe({
      next: () => {
        this.agentSaving.set(false);
        this.closeAgentForm();
        this.loadAgents();
        this.notify(this.language() === 'es' ? 'Agente guardado.' : 'Agent saved.');
      },
      error: error => {
        this.agentSaving.set(false);
        this.notify(this.errorMessage(error));
      }
    });
  }

  deleteAgent(agent: Agent) {
    const message = this.language() === 'es'
      ? 'Eliminar al agente ' + agent.name + '?'
      : 'Delete agent ' + agent.name + '?';
    if (!confirm(message)) return;
    this.http.delete('/api/agents/' + agent.id, this.authOptions()).subscribe({
      next: () => {
        this.loadAgents();
        this.notify(this.language() === 'es' ? 'Agente eliminado.' : 'Agent deleted.');
      },
      error: error => this.notify(this.errorMessage(error))
    });
  }

  private loadClients() {
    this.http.get<ClientUser[]>('/api/users', this.authOptions()).subscribe({
      next: clients => this.clients.set(clients),
      error: error => this.notify(this.errorMessage(error))
    });
  }

  private loadChecks() {
    this.http.get<CheckRecord[]>('/api/checks', this.authOptions()).subscribe({
      next: checks => this.checks.set(checks),
      error: error => this.notify(this.errorMessage(error))
    });
  }

  async loadReconciliation() {
    this.reconciliationLoading.set(true);
    try {
      let page = 1; let result: ReconciliationResponse | null = null; const rows: ReconciliationRow[] = [];
      do {
        result = await firstValueFrom(this.http.get<ReconciliationResponse>(`/api/reconciliation?page=${page}&pageSize=100`, this.authOptions()));
        rows.push(...(result.rows || []));
        if (!result.pagination || rows.length >= result.pagination.total || !result.rows.length) break;
        page += 1;
      } while (page < 1000);
      if (result) { this.reconciliationRows.set(rows); this.reconciliationTotals.set(result.totals); this.reconciliationSource.set(result.source); this.reconciliationStatementSource.set(result.statementSource || ''); }
    } catch (error) { this.notify(this.errorMessage(error)); }
    finally { this.reconciliationLoading.set(false); }
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
        (event.target as HTMLInputElement).value = '';
        this.search.set('');
        this.reconciliationDateFrom.set('');
        this.reconciliationDateTo.set('');
        this.reconciliationHeaderFilter.set(null);
        this.reconciliationFolioFilter.set('');
        this.reconciliationSeriesFilter.set('');
        this.reconciliationClientFilter.set('');
        this.reconciliationResultFilter.set('all');
        this.reconciliationValidationFilter.set('all');
        this.loadReconciliation();
      },
      error: error => {
        this.reconciliationLoading.set(false);
        (event.target as HTMLInputElement).value = '';
        this.notify(this.errorMessage(error));
      }
    });
  }

  private authOptions() {
    return { headers: new HttpHeaders({ Authorization: `Bearer ${sessionStorage.getItem('fc-token') || ''}` }) };
  }

  private clearSession() {
    if (this.invoiceSyncPollTimer) {
      clearTimeout(this.invoiceSyncPollTimer);
      this.invoiceSyncPollTimer = null;
    }
    this.invoiceSyncProgress.set(null);
    this.isSyncingInvoices.set(false);
    localStorage.removeItem(this.invoiceSyncJobStorageKey);
    sessionStorage.removeItem('fc-token');
    sessionStorage.removeItem('fc-user');
    sessionStorage.removeItem(this.walmexCacheKey);
    this.user.set(null);
    this.invoices.set([]);
    this.clients.set([]);
    this.notifications.set([]);
    this.notificationOpen.set(false);
    this.supportOpen.set(false);
    this.supportConversationTicket.set(null);
    this.supportNotificationLoading.set(false);
    this.supportSending.set(false);
    this.supportReplySending.set(false);
    this.toast.set('');
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
    return { id: 0, folio: '', poNumber: '', guideNumber: '', client: '', email: '', concept: '', issued: today, due: this.addOneMonth(today), amount: 0, status: 'Pendiente' };
  }

  private emptyEditInvoice() {
    const today = new Date().toISOString().slice(0, 10);
    return { folio: '', poNumber: '', guideNumber: '', client: '', email: '', concept: '', issued: today, due: this.addOneMonth(today), amount: 0, balance: 0, status: 'Pendiente' as Status };
  }

  private addOneMonth(dateText: string) {
    const date = new Date(`${dateText}T00:00:00`);
    date.setMonth(date.getMonth() + 1);
    return date.toISOString().slice(0, 10);
  }
}
