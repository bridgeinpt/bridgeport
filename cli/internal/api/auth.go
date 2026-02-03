package api

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type LoginResponse struct {
	Token string `json:"token"`
	User  struct {
		ID    string `json:"id"`
		Email string `json:"email"`
		Role  string `json:"role"`
	} `json:"user"`
}

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Role  string `json:"role"`
}

// Login authenticates with the API and returns a token
func (c *Client) Login(email, password string) (*LoginResponse, error) {
	req := LoginRequest{
		Email:    email,
		Password: password,
	}
	var resp LoginResponse
	if err := c.Post("/api/auth/login", req, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// GetCurrentUser returns the currently authenticated user
func (c *Client) GetCurrentUser() (*User, error) {
	var user User
	if err := c.Get("/api/auth/me", &user); err != nil {
		return nil, err
	}
	return &user, nil
}

// ValidateToken checks if the current token is valid
func (c *Client) ValidateToken() bool {
	_, err := c.GetCurrentUser()
	return err == nil
}
