async function handleResetPassword(e) {
    e.preventDefault();
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const errorEl = document.getElementById('resetError');
    const successEl = document.getElementById('resetSuccess');
    const submitBtn = document.querySelector('.btn-submit');

    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');

    if (!token) {
        errorEl.textContent = 'Invalid or missing reset token.';
        return;
    }

    if (newPassword !== confirmPassword) {
        errorEl.textContent = 'Passwords do not match.';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Resetting...';

    try {
        const response = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, new_password: newPassword })
        });

        const data = await response.json();

        if (response.ok) {
            successEl.classList.remove('hidden');
            errorEl.textContent = '';
            setTimeout(() => { window.location.href = '/'; }, 2000);
        } else {
            errorEl.textContent = data.error || 'Failed to reset password.';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Reset Password';
        }
    } catch (error) {
        errorEl.textContent = 'Connection error.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Reset Password';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('resetForm');
    if (form) form.addEventListener('submit', handleResetPassword);
});
