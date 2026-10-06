/** Report ids (r_…), site audit ids (a_…) and job ids (j_…). The server validates every id with this before it touches a file or a map; the UI uses it too. */
export const ID_PATTERN = /^[rja]_[a-z0-9]{6,40}$/;
