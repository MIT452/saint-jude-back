import Swal from 'sweetalert2';

export const showSuccess = (message: string) => {
  return Swal.fire({
    icon: 'success',
    title: 'Succès',
    text: message,
    confirmButtonText: 'OK',
  });
};

export const showError = (message: string) => {
  return Swal.fire({
    icon: 'error',
    title: 'Erreur',
    text: message,
    confirmButtonText: 'OK',
  });
};

export const showWarning = (message: string) => {
  return Swal.fire({
    icon: 'warning',
    title: 'Attention',
    text: message,
    confirmButtonText: 'OK',
  });
};