// yossi hadad -312588288 , yarin haronov - 318467206 

// Select the form and input elements from the document
const form = document.querySelector('form');
const firstNameInput = document.getElementById('firstName');
const lastNameInput = document.getElementById('lastName');
const phoneInput = document.getElementById('phone');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirmPassword');

// Add an event listener to handle form submission
form.addEventListener('submit', function(event) {
    event.preventDefault(); // Prevent the default form submission behavior

    if (validateForm()) {
        console.log('פרטי הטופס תקינים, ניתן להמשיך לשליחה'); // Log success message if validation passes
    }
    else{
        console.log("פרטי הטופס אינם תקינים"); // Log error message if validation fails
    }
});

// Function to validate form inputs
function validateForm() {
    // Trim the values from the input fields to remove whitespace
    const firstNameValue = firstNameInput.value.trim();
    const lastNameValue = lastNameInput.value.trim();
    const phoneValue = phoneInput.value.trim();
    const emailValue = emailInput.value.trim();
    const passwordValue = passwordInput.value;
    const confirmPasswordValue = confirmPasswordInput.value;

    // Select the password comment span to show/hide messages
    const passwordComment = document.getElementById('password-comment');

    // Check if the password and confirm password fields match
    if(passwordValue !== confirmPasswordValue){ 
       passwordComment.style.visibility = 'visible'; // Show the password mismatch error
       return false; // Return false to indicate validation failure
    }else{
       passwordComment.style.visibility = 'hidden'; // Hide the error if passwords match
    }

    // Hide the password error if the password field is empty
    if (passwordValue.value === "") {
        document.querySelector("#password-comment").style.visibility = "hidden";
    }
    
    return true; // Return true if all validations pass
}
