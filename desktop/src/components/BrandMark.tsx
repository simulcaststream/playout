import appIcon from "../assets/playout-icon.png";
import logo from "../assets/simulcast-stream.png";

export default function BrandMark() {
  return (
    <div className="brand-mark">
      <img src={appIcon} alt="" className="brand-app-icon" aria-hidden="true" />
      <span className="brand-name">Playout</span>
      <span className="brand-by">by</span>
      <img src={logo} alt="simulcast.stream" className="brand-logo" />
    </div>
  );
}
