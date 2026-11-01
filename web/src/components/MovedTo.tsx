import { Navigate, useLocation } from "react-router-dom";

/** Old addresses keep working: the page moved, the filters in the query string stay. */
export function MovedTo({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={{ pathname: to, search }} replace />;
}
